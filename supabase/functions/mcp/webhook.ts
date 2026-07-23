/**
 * GitHub webhook handler.
 * Listens for pull_request_review_comment, pull_request_review, and
 * issue_comment events (the last covers PR inline comments) and creates
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
 * Uses crypto.subtle.verify (HMAC verify operation) instead of signing and
 * comparing hex strings — this avoids the manual timing-safe XOR loop and
 * is the correct idiomatic approach for the Web Crypto API.
 *
 * The WEBHOOK_SECRET is read inside this function (not at module load time)
 * so that Supabase propagates the secret before the first verification runs,
 * even on a fresh cold-start after deployment.
 */
async function verifyHmac(body: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
  if (!signature || !secret) return false;

  // GitHub sends: sha256=<64-hex-chars>
  if (!signature.startsWith('sha256=')) return false;
  const hexSig = signature.slice(7);

  // Decode the hex signature to raw bytes for crypto.subtle.verify
  if (hexSig.length !== 64 || !/^[0-9a-f]+$/i.test(hexSig)) return false;
  const sigBytes = new Uint8Array(hexSig.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}

async function processWebhook(req: Request, span: Span): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');
  const body = await req.text();

  span.setAttributes({ 'lorekit.webhook.event': event });

  if (!await verifyHmac(body, signature)) {
    span.error('HmacError: signature mismatch');
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
    // issue_comment fires for both issue and PR comments; only capture PR comments
    if (payload['issue']?.pull_request) {
      commentBody = payload['comment']?.body;
      commentUrl = payload['comment']?.html_url;
    }
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
