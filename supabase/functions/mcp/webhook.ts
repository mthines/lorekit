/**
 * GitHub webhook handler.
 * Listens for pull_request_review_comment and pull_request_review events
 * and creates candidate memory entries tagged source::pr-webhook.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope } from '../_shared/scope.ts';
import { traceRequest, type Span } from '../_shared/otel.ts';
import { toolWrite } from './tools.ts';

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const WEBHOOK_SECRET = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';

async function verifyHmac(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = `sha256=${hex}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
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
  }

  if (!commentBody?.trim()) return new Response('OK', { status: 200 });

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
