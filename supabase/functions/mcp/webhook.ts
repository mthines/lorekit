/**
 * GitHub webhook handler.
 * Listens for pull_request_review_comment, pull_request_review, and
 * issue_comment events (all issue and PR comments) and creates
 * candidate memory entries tagged source::pr-webhook.
 *
 * Unsupported event types return 200 OK but are marked with
 * lorekit.webhook.skipped=true on the span so they are visible in Dash0.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope } from '../_shared/scope.ts';
import { traceRequest, type Span } from '../_shared/otel.ts';
import { toolWrite } from './tools.ts';

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

const SUPPORTED_EVENTS = new Set([
  'pull_request_review_comment',
  'pull_request_review',
  'issue_comment',
]);

/**
 * Verify a GitHub webhook HMAC-SHA256 signature using the Web Crypto API.
 *
 * Accepts the raw body bytes (not a decoded string) to avoid any encoding
 * round-trip loss. Returns a result object with diagnostic fields so the
 * caller can surface them as span attributes for observability.
 */
async function verifyHmac(
  bodyBytes: ArrayBuffer,
  signature: string | null,
): Promise<{ ok: boolean; secretConfigured: boolean; signaturePresent: boolean; failReason?: string }> {
  const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
  const secretConfigured = secret.length > 0;
  const signaturePresent = !!signature && signature.length > 0;

  if (!signaturePresent) {
    return { ok: false, secretConfigured, signaturePresent, failReason: 'no_signature_header' };
  }
  if (!secretConfigured) {
    return { ok: false, secretConfigured, signaturePresent, failReason: 'secret_not_configured' };
  }
  if (!signature!.startsWith('sha256=')) {
    return { ok: false, secretConfigured, signaturePresent, failReason: 'invalid_signature_format' };
  }

  const hexSig = signature!.slice(7);
  if (hexSig.length !== 64 || !/^[0-9a-f]+$/i.test(hexSig)) {
    return { ok: false, secretConfigured, signaturePresent, failReason: 'invalid_signature_hex' };
  }

  const sigBytes = new Uint8Array(hexSig.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // Verify directly over raw wire bytes — no text decode/re-encode round-trip
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
  return { ok, secretConfigured, signaturePresent, failReason: ok ? undefined : 'hmac_mismatch' };
}

async function processWebhook(req: Request, span: Span): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');

  span.setAttributes({ 'lorekit.webhook.event': event });

  // Read body once as raw bytes; derive the string for JSON parsing from the
  // same buffer so both operations see identical byte content.
  const bodyBytes = await req.arrayBuffer();
  const body = new TextDecoder().decode(bodyBytes);

  const hmac = await verifyHmac(bodyBytes, signature);

  // Always record diagnostic attributes — these are the ground truth for
  // debugging HMAC failures without guessing.
  span.setAttributes({
    'lorekit.webhook.secret_configured': hmac.secretConfigured,
    'lorekit.webhook.signature_present': hmac.signaturePresent,
    'lorekit.webhook.body_bytes': bodyBytes.byteLength,
  });

  if (!hmac.ok) {
    span.setAttributes({ 'lorekit.webhook.hmac_fail_reason': hmac.failReason ?? 'unknown' });
    span.error(`HmacError: ${hmac.failReason ?? 'signature mismatch'}`);
    return new Response('Unauthorized', { status: 401 });
  }

  // Report unsupported event types so they are visible in Dash0 rather than
  // silently discarded. We still return 200 OK — GitHub retries on 4xx/5xx
  // which would flood the delivery log for every push, star, etc.
  if (!SUPPORTED_EVENTS.has(event)) {
    span.setAttributes({
      'lorekit.webhook.skipped': true,
      'lorekit.webhook.skip_reason': 'unsupported_event',
    });
    return new Response('OK', { status: 200 });
  }

  // deno-lint-ignore no-explicit-any
  const payload = JSON.parse(body) as Record<string, any>;
  const action = payload['action'] ?? 'unknown';
  const repo = payload['repository']?.full_name;
  span.setAttributes({ 'lorekit.webhook.action': action });

  if (!repo) return new Response('OK', { status: 200 });

  let commentBody: string | undefined;
  let commentUrl: string | undefined;

  if (event === 'pull_request_review_comment') {
    commentBody = payload['comment']?.body;
    commentUrl = payload['comment']?.html_url;
  } else if (event === 'pull_request_review') {
    commentBody = payload['review']?.body;
    commentUrl = payload['review']?.html_url;
  } else if (event === 'issue_comment') {
    // Capture all issue comments (plain issues and PR comments alike)
    commentBody = payload['comment']?.body;
    commentUrl = payload['comment']?.html_url;
  }

  if (!commentBody?.trim()) {
    span.setAttributes({ 'lorekit.webhook.skipped': true, 'lorekit.webhook.skip_reason': 'empty_body' });
    return new Response('OK', { status: 200 });
  }

  const scope = validateScope(`repo::${repo}`);
  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.scope.type': 'repo' });

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await toolWrite(db, {
    scope,
    key: `pr-webhook::${repo}::${Date.now()}`,
    value: commentBody.trim(),
    tags: [
      'source::pr-webhook',
      `event::${event}`,
      `action::${action}`,
      ...(commentUrl ? [`url::${commentUrl}`] : []),
    ],
    source_agent: 'github-webhook',
    trigger: `${event}.${action}`,
  }, null, span);

  return new Response('OK', { status: 200 });
}

export function handleWebhook(req: Request): Promise<Response> {
  return traceRequest(req, 'lorekit.webhook.github', (span) => processWebhook(req, span));
}

