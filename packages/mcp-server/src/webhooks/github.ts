/**
 * GitHub webhook handler for LoreKit.
 * Listens for pull_request_review_comment and pull_request_review events.
 * Creates a candidate memory entry tagged source::pr-webhook.
 *
 * Per otel-instrumentation skills: spans on all operations.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { createServiceClient, getTracer, write, validateScope } from '@lorekit/core';
import { logger } from '../logger.js';
import { createHmac, timingSafeEqual } from 'crypto';

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

      if (event === 'pull_request_review_comment') {
        const comment = payload['comment'] as { body?: string; html_url?: string } | undefined;
        commentBody = comment?.body;
        commentUrl = comment?.html_url;
      } else if (event === 'pull_request_review') {
        const review = payload['review'] as { body?: string; html_url?: string } | undefined;
        commentBody = review?.body;
        commentUrl = review?.html_url;
      }

      if (!commentBody?.trim()) {
        span.addEvent('webhook.skipped', { reason: 'empty comment body' });
        logger.info({ scope, event, action }, 'lorekit.webhook.skipped');
        return new Response('OK', { status: 200 });
      }

      const db = createServiceClient(getSupabaseUrl(), getSupabaseServiceRoleKey());
      const key = `pr-webhook::${repo}::${Date.now()}`;

      await write(db, {
        scope,
        key,
        value: commentBody.trim(),
        tags: [
          'source::pr-webhook',
          `event::${event}`,
          `action::${action}`,
          ...(commentUrl ? [`url::${commentUrl}`] : []),
        ],
        source_agent: 'github-webhook',
        trigger: `${event}.${action}`,
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
