/**
 * GitHub webhook handler for LoreKit.
 * Listens for pull_request_review_comment, pull_request_review,
 * pull_request_review_thread, and issue_comment events.
 * Creates a candidate memory entry tagged source::pr-webhook.
 *
 * Also listens for `pull_request` closed, which writes nothing: a merged PR
 * retires the per-PR state record `pr-reviewer` keeps, and this archives it so
 * the record goes at merge rather than seven days later. See handlePrStatePurge
 * for why that purge is best-effort by design.
 *
 * Two signal-quality gates are applied before every write:
 *   1. classifyWebhookAction — only 'created', 'submitted', and 'resolved'
 *      actions carry durable signal; edits, deletes, dismissals are skipped.
 *   2. isSignalWorthy — rejects short bodies, bot noise, and code-only blocks.
 *
 * All webhook-sourced memories are stored with a TTL — they are candidates, not
 * promoted lessons, and should decay unless re-surfaced. The number of days is
 * graded by the delivery's signal tier (webhookTtlDays, ttl-defaults.ts) rather
 * than flat, because gate 1 already knows a resolved thread outranks a fresh
 * comment.
 *
 * Per otel-instrumentation skills: spans on all operations.
 */
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  createServiceClient,
  deleteMemory,
  getTracer,
  sanitizeOrigin,
  webhookSignalTier,
  webhookTtlDays,
  write,
  validateScope,
} from '@lorekit/core';
import { logger } from '../logger.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { classifyWebhookAction, isSignalWorthy, prStatePurgeTarget } from './signal-filter.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Read lazily (not as module-level consts) so tests that set process.env in
// beforeEach — after this module has already been imported — see the value
// they configured.
function getWebhookSecret(): string {
  return process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
}
function getSupabaseUrl(): string {
  return process.env['SUPABASE_URL'] ?? '';
}
function getSupabaseServiceRoleKey(): string {
  return process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
}

function verifyHmac(body: string, signature: string | null): boolean {
  const webhookSecret = getWebhookSecret();
  if (!signature || !webhookSecret) return false;
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Archive the per-PR state record a merged pull request retires.
 *
 * `pr-reviewer` (mthines/agent-skills) keeps one state record per PR holding its
 * delta baseline, run-mode history, open threads and carried findings. The
 * record carries a 7-day TTL refreshed on every write, so it already expires a
 * week after the PR goes quiet — **nothing here is required for correctness.**
 * This makes the cleanup immediate instead of eventual, because a merged PR's
 * delta state is dead the moment it merges.
 *
 * That is why every failure path below returns quietly. The TTL is the
 * mechanism; this is an accelerant, and an accelerant must never turn a
 * successful delivery into a 500 that GitHub then retries.
 *
 * **Ownership is the load-bearing part.** `deleteMemory` only adds `user_id` to
 * its match filter when a user id is passed; with `null` it matches on
 * (scope, key) alone, and since that pair is unique *per user*, a null-owner
 * archive would hit every account holding a record at the same coordinates. A
 * webhook is anonymous, so the owner is resolved from the App installation:
 * `github_installations` maps `installation_id → user_id`, and only once a login
 * has linked it (`status = 'linked'`; a fresh install sits at `'pending'` with a
 * NULL user_id). No linked owner ⇒ no purge, and the TTL collects the record as
 * it would have anyway. Deleting on behalf of an account we cannot name is not
 * a degraded version of this feature; it is a different, worse one.
 */
async function handlePrStatePurge(
  db: SupabaseClient,
  event: string,
  action: string,
  payload: Record<string, unknown>,
  span: Span,
): Promise<void> {
  const target = prStatePurgeTarget(event, action, payload as Parameters<typeof prStatePurgeTarget>[2]);
  if (!target) {
    span.addEvent('webhook.purge.skipped', { reason: 'not_a_merged_pull_request' });
    return;
  }

  const installationId = (payload['installation'] as { id?: number } | undefined)?.id;
  if (!installationId) {
    // A legacy repo-level webhook carries no installation, so there is no owner
    // to attribute the archive to. Left to the TTL.
    span.addEvent('webhook.purge.skipped', { reason: 'no_installation_in_payload' });
    return;
  }

  const { data, error } = await db
    .from('github_installations')
    .select('user_id')
    .eq('installation_id', installationId)
    .eq('status', 'linked')
    .maybeSingle();

  const userId = (data as { user_id?: string | null } | null)?.user_id ?? null;
  if (error || !userId) {
    span.addEvent('webhook.purge.skipped', {
      reason: error ? 'installation_lookup_failed' : 'installation_not_linked_to_a_user',
    });
    return;
  }

  span.setAttribute('lorekit.scope', target.scope);
  span.setAttribute('lorekit.key', target.key);

  // force: false — soft-archive. The row is hidden from reads (so pr-reviewer's
  // next run takes its first-run path, which is the intended outcome) and the
  // retention job hard-deletes it later. An irreversible delete driven by an
  // inbound webhook buys nothing here.
  const result = await deleteMemory(db, { scope: target.scope, key: target.key, force: false }, userId);

  span.addEvent('webhook.purge.done', { archived: result.archived, deleted: result.deleted });
  logger.info(
    { scope: target.scope, key: target.key, archived: result.archived },
    'lorekit.webhook.pr_state_purged',
  );
}

export async function handleGitHubWebhook(req: Request): Promise<Response> {
  const tracer = getTracer();

  return tracer.startActiveSpan('lorekit.webhook.github', { kind: 0 }, async (span) => {
    const event = req.headers.get('x-github-event') ?? 'unknown';
    const signature = req.headers.get('x-hub-signature-256');

    span.setAttribute('lorekit.webhook.event', event);

    try {
      const body = await req.text();

      if (!verifyHmac(body, signature)) {
        span.addEvent('webhook.hmac.failed');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'HmacError: signature mismatch' });
        return new Response('Unauthorized', { status: 401 });
      }

      const payload = JSON.parse(body) as Record<string, unknown>;
      const action = (payload['action'] as string) ?? 'unknown';
      span.setAttribute('lorekit.webhook.action', action);

      // A merged pull_request retires per-PR state and writes nothing, so it
      // is handled before the write pipeline and returns early. It is checked
      // BEFORE the SKIP gate on purpose: PURGE is its own tier precisely so a
      // purge delivery is never silently classified as noise.
      if (classifyWebhookAction(event, action) === 'PURGE') {
        const db = createServiceClient(getSupabaseUrl(), getSupabaseServiceRoleKey());
        try {
          await handlePrStatePurge(db, event, action, payload, span);
        } catch (purgeErr) {
          // Swallowed with the reason recorded: the TTL is the real mechanism
          // (see handlePrStatePurge), and a 500 here makes GitHub retry a
          // delivery that had nothing to deliver.
          const pe = purgeErr as Error;
          span.addEvent('webhook.purge.failed', { 'exception.type': pe.name, 'exception.message': pe.message });
          logger.warn({ 'exception.type': pe.name, 'exception.message': pe.message }, 'lorekit.webhook.purge_failed');
        }
        return new Response('OK', { status: 200 });
      }

      // Layer 1 — action-tier gate: skip edits, deletes, dismissals, etc.
      if (classifyWebhookAction(event, action) === 'SKIP') {
        span.addEvent('webhook.skipped', { reason: 'action_not_signal_worthy' });
        logger.info({ event, action }, 'lorekit.webhook.skipped');
        return new Response('OK', { status: 200 });
      }

      // Extract repo scope from the payload
      const repo = (payload['repository'] as { full_name?: string } | undefined)?.full_name;
      if (!repo) {
        span.addEvent('webhook.skipped', { reason: 'no repository in payload' });
        return new Response('OK', { status: 200 });
      }

      const scope = validateScope(`repo::${repo}`);
      span.setAttribute('lorekit.scope', scope);
      span.setAttribute('lorekit.scope.type', 'repo');

      let commentBody: string | undefined;
      let commentUrl: string | undefined;
      const extraTags: string[] = [];

      if (event === 'pull_request_review_comment') {
        const comment = payload['comment'] as { body?: string; html_url?: string } | undefined;
        commentBody = comment?.body;
        commentUrl = comment?.html_url;
      } else if (event === 'pull_request_review') {
        const review = payload['review'] as { body?: string; html_url?: string } | undefined;
        commentBody = review?.body;
        commentUrl = review?.html_url;
      } else if (event === 'issue_comment') {
        const comment = payload['comment'] as { body?: string; html_url?: string } | undefined;
        commentBody = comment?.body;
        commentUrl = comment?.html_url;
      } else if (event === 'pull_request_review_thread') {
        // Resolved thread: the first comment in the thread is the finding.
        // This is the highest-signal event — explicit author acknowledgement.
        const thread = payload['thread'] as
          | { comments?: Array<{ body?: string; html_url?: string }> }
          | undefined;
        commentBody = thread?.comments?.[0]?.body;
        commentUrl = thread?.comments?.[0]?.html_url;
        extraTags.push('signal::resolved-thread');
      }

      // Layer 2 — body quality gate: reject noise before touching the DB.
      if (!commentBody?.trim() || !isSignalWorthy(commentBody)) {
        span.addEvent('webhook.skipped', { reason: 'body_not_signal_worthy' });
        logger.info({ scope, event, action }, 'lorekit.webhook.skipped');
        return new Response('OK', { status: 200 });
      }

      // Provenance: the delivery already names the pull request this comment
      // belongs to, so record it as first-class origin rather than leaving the
      // link buried in an untyped `url::` tag. Mirrors the edge receiver
      // (supabase/functions/mcp/webhook.ts). A comment on a plain issue has no
      // `pull_request` key, so no PR origin is recorded.
      const pull = payload['pull_request'] as
        | { number?: number; head?: { ref?: string; sha?: string } }
        | undefined;
      const issue = payload['issue'] as { number?: number; pull_request?: unknown } | undefined;
      const prNumber = pull?.number ?? (issue?.pull_request ? issue.number : undefined);
      // Sanitised, not validated — a field we cannot make sense of is dropped
      // rather than failing the ingest. Mirrors the edge receiver.
      const origin = sanitizeOrigin({
        origin_repo: repo,
        origin_pr: prNumber,
        origin_branch: pull?.head?.ref,
        origin_commit: pull?.head?.sha,
      });

      const db = createServiceClient(getSupabaseUrl(), getSupabaseServiceRoleKey());
      const key = `pr-webhook::${repo}::${Date.now()}`;

      // Layer 3 — TTL: webhook memories are candidates, not promoted lessons, so
      // they decay. How fast depends on the signal tier gate 1 already assigned;
      // the second argument of webhookTtlDays is where a per-repo override will
      // be threaded once it is configurable.
      const ttlDays = webhookTtlDays(event, action);
      span.setAttribute('lorekit.webhook.signal_tier', webhookSignalTier(event, action));
      span.setAttribute('lorekit.webhook.ttl_days', ttlDays);

      await write(db, {
        scope,
        key,
        value: commentBody.trim(),
        ttl_days: ttlDays,
        tags: [
          'source::pr-webhook',
          `event::${event}`,
          `action::${action}`,
          ...extraTags,
          ...(commentUrl ? [`url::${commentUrl}`] : []),
        ],
        source_agent: 'github-webhook',
        trigger: `${event}.${action}`,
        ...origin,
      });

      span.setAttribute('lorekit.key', key);
      logger.info({ scope, key, event, action }, 'lorekit.webhook.entry_created');
      return new Response('OK', { status: 200 });
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      logger.error(
        { 'exception.type': e.name, 'exception.message': e.message, 'exception.stacktrace': e.stack },
        'lorekit.webhook.error',
      );
      return new Response('Internal Server Error', { status: 500 });
    } finally {
      span.end();
    }
  });
}
