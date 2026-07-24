/**
 * GitHub webhook handler.
 * Listens for pull_request_review_comment, pull_request_review, and
 * issue_comment events (all issue and PR comments) and creates
 * candidate memory entries tagged source::pr-webhook.
 *
 * Unsupported event types return 200 OK but are marked with
 * lorekit.webhook.skipped=true on the span so they are visible in Dash0.
 *
 * Secret lookup strategy:
 *   1. Look up the repo owner's active webhook secret from the webhook_secrets
 *      table (keyed by user_id, matched via the sender.login claim in the payload).
 *      This is the primary path — secrets are stored server-side and owned per user.
 *   2. Fall back to the GITHUB_WEBHOOK_SECRET env var for backwards compatibility
 *      (existing deployments that set the env var before the DB-backed flow was added).
 *
 * This replaces the previous approach where the secret was generated client-side
 * (ephemeral, not stored) and the user had to manually copy it into env vars.
 * See: optimize-approach analysis — codebase-fit + robustness axes both fired.
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
 * Resolve candidate HMAC secrets for this webhook delivery.
 *
 * Primary: look up the repo owner's active webhook secret via auth.users.
 * Supabase stores the GitHub login in raw_user_meta_data['user_name'] for
 * OAuth users — the stable cross-system identifier we join on.
 * Returns all matching secrets so the caller can try each — handles the
 * uncommon case of multiple LoreKit users under the same GitHub org login.
 *
 * Fallback: GITHUB_WEBHOOK_SECRET env var (backwards compat for deployments
 * that pre-date the webhook_secrets table).
 */
async function resolveSecrets(
  db: ReturnType<typeof createClient>,
  ownerLogin: string | undefined,
): Promise<{ secrets: string[]; source: 'db' | 'env' | 'none' }> {
  if (ownerLogin) {
    // auth.admin.listUsers() is available to the service-role client and returns
    // raw_user_meta_data, which Supabase populates from GitHub OAuth.
    // deno-lint-ignore no-explicit-any
    const { data: usersPage } = await (db.auth.admin as any).listUsers({ perPage: 1000 });
    // deno-lint-ignore no-explicit-any
    const userIds: string[] = (usersPage?.users ?? [])
      .filter((u: any) => u.raw_user_meta_data?.['user_name'] === ownerLogin)
      .map((u: any) => u.id as string);

    if (userIds.length > 0) {
      const { data: rows } = await db
        .from('webhook_secrets')
        .select('secret')
        .in('user_id', userIds)
        .eq('active', true)
        .order('created_at', { ascending: false });

      const secrets = (rows ?? [])
        .map((r: { secret: string }) => r.secret)
        .filter(Boolean) as string[];
      if (secrets.length > 0) return { secrets, source: 'db' };
    }
  }

  // Fallback: env var
  const envSecret = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
  if (envSecret) return { secrets: [envSecret], source: 'env' };

  return { secrets: [], source: 'none' };
}

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
  secret: string,
  secretSource: 'db' | 'env' | 'none',
): Promise<{ ok: boolean; secretConfigured: boolean; signaturePresent: boolean; secretSource: string; failReason?: string }> {
  const secretConfigured = secret.length > 0;
  const signaturePresent = !!signature && signature.length > 0;

  if (!signaturePresent) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'no_signature_header' };
  }
  if (!secretConfigured) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'secret_not_configured' };
  }
  if (!signature!.startsWith('sha256=')) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'invalid_signature_format' };
  }

  const hexSig = signature!.slice(7);
  if (hexSig.length !== 64 || !/^[0-9a-f]+$/i.test(hexSig)) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'invalid_signature_hex' };
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
  return { ok, secretConfigured, signaturePresent, secretSource, failReason: ok ? undefined : 'hmac_mismatch' };
}

async function processWebhook(req: Request, span: Span): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');

  span.setAttributes({ 'lorekit.webhook.event': event });

  // Read body once as raw bytes; derive the string for JSON parsing from the
  // same buffer so both operations see identical byte content.
  const bodyBytes = await req.arrayBuffer();
  const body = new TextDecoder().decode(bodyBytes);

  // Parse enough of the payload to identify the repo owner before HMAC verification.
  // We need the owner login to look up the correct secret from the DB.
  // deno-lint-ignore no-explicit-any
  let earlyPayload: Record<string, any> = {};
  try { earlyPayload = JSON.parse(body); } catch { /* handled below */ }

  const ownerLogin = earlyPayload['repository']?.owner?.login as string | undefined;

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { secrets, source: secretSource } = await resolveSecrets(db, ownerLogin);

  // Try each candidate secret in order. Single-user: one iteration.
  // Multi-user org: tries each until one verifies.
  const candidates = secrets.length > 0 ? secrets : ['']; // empty string → triggers not_configured path
  let hmac = await verifyHmac(bodyBytes, signature, candidates[0], secretSource);
  for (let i = 1; i < candidates.length && !hmac.ok; i++) {
    hmac = await verifyHmac(bodyBytes, signature, candidates[i], secretSource);
  }

  // Always record diagnostic attributes — these are the ground truth for
  // debugging HMAC failures without guessing.
  span.setAttributes({
    'lorekit.webhook.secret_configured': hmac.secretConfigured,
    'lorekit.webhook.secret_source': hmac.secretSource,
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

  try {
    const action = earlyPayload['action'] ?? 'unknown';
    const repo = earlyPayload['repository']?.full_name;
    span.setAttributes({ 'lorekit.webhook.action': action });

    if (!repo) return new Response('OK', { status: 200 });

    let commentBody: string | undefined;
    let commentUrl: string | undefined;

    if (event === 'pull_request_review_comment') {
      commentBody = earlyPayload['comment']?.body;
      commentUrl = earlyPayload['comment']?.html_url;
    } else if (event === 'pull_request_review') {
      commentBody = earlyPayload['review']?.body;
      commentUrl = earlyPayload['review']?.html_url;
    } else if (event === 'issue_comment') {
      commentBody = earlyPayload['comment']?.body;
      commentUrl = earlyPayload['comment']?.html_url;
    }

    if (!commentBody?.trim()) {
      span.setAttributes({ 'lorekit.webhook.skipped': true, 'lorekit.webhook.skip_reason': 'empty_body' });
      return new Response('OK', { status: 200 });
    }

    const scope = validateScope(`repo::${repo}`);
    span.setAttributes({ 'lorekit.scope': scope, 'lorekit.scope.type': 'repo' });

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
  } catch (err) {
    const e = err as Error;
    span.setAttributes({
      'lorekit.webhook.error.type': e.name,
      'lorekit.webhook.error.message': e.message,
    });
    span.error(`${e.name}: ${e.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export function handleWebhook(req: Request): Promise<Response> {
  return traceRequest(req, 'lorekit.webhook.github', (span) => processWebhook(req, span));
}
