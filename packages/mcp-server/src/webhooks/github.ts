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

const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

function verifyHmac(body: string, signature: string | null): boolean {
  if (!signature || !WEBHOOK_SECRET) return false;
  const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
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

      const db = createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const prNumber = (
        (payload['pull_request'] as { number?: number } | undefined) ??
        (payload['comment'] as { pull_request_url?: string } | undefined)
      );
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
