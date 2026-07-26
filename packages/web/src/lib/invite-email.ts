/**
 * sendInviteEmail — fire a transactional org-invite email via Resend.
 *
 * A plain (NOT `'use server'`) impure-shell module: it reads env + calls
 * `fetch` and nothing else (no `next/cache`, no supabase), so it's importable
 * by a node-env vitest spec — the `mcp-url.ts` pattern.
 *
 * NON-THROWING by contract, mirroring `recordAuditEvent` (audit-log.ts): the
 * whole body is guarded, so an email failure (bad key, unverified domain,
 * network error) can never break the invite that already succeeded in the DB.
 * Callers do not need their own try/catch.
 *
 * No-ops (no network call) when there's no real recipient, or when
 * `RESEND_API_KEY` is unset — so local/dev and any environment without the key
 * work unchanged and invites still succeed; only handle-only invites and
 * key-less environments simply send nothing.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';

export interface InviteEmailInput {
  /** invitee_email — the helper no-ops if this is falsy or lacks an '@'. */
  to: string | null;
  /** Resolved org name (caller falls back to slug / a generic label). */
  orgName: string;
  /** 'admin' | 'member' | 'viewer'. */
  role: string;
  /** GitHub handle or email of the inviter, when resolvable. */
  invitedByLabel?: string | null;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'LoreKit <invites@lorekit.io>';
const DEFAULT_APP_URL = 'https://lorekit-io.vercel.app';

// The SDK is initialised by @vercel/otel in instrumentation.ts; this only calls
// the API (no-op tracer if no SDK is registered, e.g. under vitest). The
// outbound fetch is already auto-instrumented as an HTTP client span — this
// explicit parent span exists because sendInviteEmail SWALLOWS every failure by
// contract, so its `lorekit.invite.email.outcome` attribute + recorded
// exception are the only way to observe a skipped/failed send in production.
const tracer = trace.getTracer('lorekit.web');

type InviteEmailOutcome = 'sent' | 'skipped_no_recipient' | 'skipped_no_api_key' | 'error';

export async function sendInviteEmail(input: InviteEmailInput): Promise<void> {
  return tracer.startActiveSpan('lorekit.invite.email.send', async (span) => {
    // Attribute the role but NOT the recipient / org name — those are PII we
    // deliberately keep off spans.
    span.setAttribute('lorekit.invite.role', input.role);

    const finish = (outcome: InviteEmailOutcome) => {
      span.setAttribute('lorekit.invite.email.outcome', outcome);
    };

    try {
      const { to, orgName, role, invitedByLabel } = input;

      // No address to send to (handle-only invite, or empty) — nothing to do.
      if (!to || !to.includes('@')) {
        finish('skipped_no_recipient');
        return;
      }

      const apiKey = process.env['RESEND_API_KEY'];
      if (!apiKey) {
        finish('skipped_no_api_key');
        console.debug('[sendInviteEmail] RESEND_API_KEY unset — skipping invite email');
        return;
      }

      const from = process.env['RESEND_FROM'] ?? DEFAULT_FROM;
      const base = process.env['NEXT_PUBLIC_APP_URL'] ?? DEFAULT_APP_URL;
      const link = `${base}/dashboard`;

      const invitedBy = invitedByLabel ? `${invitedByLabel} invited you` : 'You have been invited';
      const subject = `You've been invited to ${orgName} on LoreKit`;

      const text = [
        `${invitedBy} to join ${orgName} on LoreKit as a ${role}.`,
        '',
        `Sign in with GitHub to accept: ${link}`,
        '',
        'LoreKit — shared, persistent memory for your agents.',
      ].join('\n');

      const html = [
        `<p>${escapeHtml(invitedBy)} to join <strong>${escapeHtml(orgName)}</strong> on LoreKit as a <strong>${escapeHtml(role)}</strong>.</p>`,
        `<p><a href="${escapeHtml(link)}">Sign in with GitHub to accept</a></p>`,
        `<p style="color:#888;font-size:12px">LoreKit — shared, persistent memory for your agents.</p>`,
      ].join('');

      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });

      if (!res.ok) {
        // Non-fatal: record and move on. The invite already exists in the DB.
        finish('error');
        span.setAttribute('lorekit.invite.email.status_code', res.status);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `resend responded ${res.status}` });
        console.error(`[sendInviteEmail] Resend responded ${res.status}`);
        return;
      }

      finish('sent');
    } catch (err) {
      finish('error');
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      console.error('[sendInviteEmail] failed:', (err as Error).message);
    } finally {
      span.end();
    }
  });
}

/** Minimal HTML-entity escaping for interpolated values in the email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
