/**
 * LoreKit MCP Edge Function — entry point.
 *
 * Routes all requests to co-located handlers:
 *   auth.ts         — resolveAuth, getDb, canWrite, canRead, getUserId
 *   permissions.ts  — READ_TOOLS/WRITE_TOOLS, toolRequires, tokenPrefixFor
 *   tools.ts        — memory.write/read/list/delete/search handlers
 *   webhook.ts      — GitHub PR comment → lesson creation
 *   mcp-handler.ts  — MCP JSON-RPC dispatcher (initialize, tools/list, tools/call)
 *
 * Observability via ../functions/_shared/otel.ts:
 *   traceRequest()           wraps each request in a root span
 *   createTracedClient()     creates child spans per Postgres query (in tools.ts)
 *
 * Required secrets (supabase secrets set --project-ref pqokxlhvnosogizsjztg):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GITHUB_WEBHOOK_SECRET
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.europe-west4.gcp.dash0-dev.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 */

import { traceRequest } from '../_shared/otel.ts';
import { resolveAuth, getDb } from './auth.ts';
import { extractToken } from './auth-token.ts';
import {
  isProtectedResourceMetadataPath,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
} from './oauth-metadata.ts';
import { handleMcp, jsonrpcError } from './mcp-handler.ts';
import { handleWebhook } from './webhook.ts';
import { handleInstallationSync } from './installation-sync.ts';
import { checkRateLimit, rateLimitMessage, recordUsageEvent, getUserPlanName } from './limits.ts';
import { resolveStorageAdapter } from './storage-adapter.ts';

/**
 * Best-effort read of the JSON-RPC request id from the body, without disturbing
 * the caller's stream (uses req.clone()). Used only on the auth-failure path so
 * the in-band error response can echo the real id — a response with id:null
 * can't be correlated to the pending tools/call and would hang the client.
 * Returns null for a missing/invalid id or an unparseable body.
 */
async function peekRequestId(req: Request): Promise<string | number | null> {
  try {
    const body = await req.clone().json();
    const id = (body as { id?: unknown })?.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Public health check — no auth, no tracing overhead
  if (url.pathname.endsWith('/healthz')) {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // OAuth protected-resource metadata (RFC 9728) — public, unauthenticated.
  // An MCP client that got a 401 reads WWW-Authenticate, fetches this exact
  // URL, and learns which authorization server to send the user to. CORS-open
  // because browser-based clients fetch it cross-origin.
  if (isProtectedResourceMetadataPath(url.pathname)) {
    return new Response(JSON.stringify(protectedResourceMetadata()), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // GitHub webhook
  if (url.pathname.endsWith('/webhooks/github')) {
    return handleWebhook(req);
  }

  // GitHub App installation sync — dashboard Setup-URL bounce records/links an
  // installation directly (user JWT), decoupled from the webhook delivery path.
  if (url.pathname.endsWith('/installations/sync')) {
    return handleInstallationSync(req);
  }

  // MCP endpoint — all paths (including auth failures) are traced so every
  // request produces at least one span. resolveAuth is intentionally inside
  // traceRequest so unauthenticated calls are still visible in telemetry.
  return traceRequest(req, 'lorekit.mcp', async (span) => {
    // resolveAuth checks Authorization header first, then ?token= query param as fallback.
    // Pass the root span so auth outcome attributes (auth.type, auth.outcome,
    // auth.user_id) land on the request span — no separate child span needed.
    const presentedToken = extractToken(
      req.headers.get('authorization'),
      url.searchParams.get('token'),
    );
    const auth = await resolveAuth(req.headers.get('authorization'), url.searchParams.get('token'), span);
    if (!auth) {
      // ── Two different failures, two different answers ──────────────────
      //
      // NO CREDENTIAL AT ALL → 401 + WWW-Authenticate (RFC 9728). This is the
      // OAuth discovery trigger: it is the ONLY way a client's "Authorize"
      // button can learn where our authorization server is. The original
      // no-401 rule was written when this was "a token-based server with no
      // OAuth flow for a 401 to drive" — there is one now, so the rule is
      // narrowed rather than kept. It is safe to narrow here and nowhere else:
      // a client that sent no credential has no pending, correlated tools/call
      // to hang (it has not been configured yet), so the stall the rule exists
      // to prevent cannot occur on this branch.
      //
      // A CREDENTIAL THAT DID NOT RESOLVE → unchanged: HTTP 200 with an
      // in-band JSON-RPC error echoing the real request id. This is the
      // configured-but-rotated-token case, and it is exactly where a 401 made
      // streamable-HTTP clients (mcp-remote) treat the response as a session
      // failure, silently retry, and hang for the length of the session.
      if (!presentedToken) {
        span.setAttributes({ 'auth.result': 'challenged', 'http.response.status_code': 401 });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32001,
              message:
                'Authorization required. Use your MCP client\'s "Authorize" action, or set a LoreKit API token.',
            },
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': wwwAuthenticateChallenge(),
              'Access-Control-Expose-Headers': 'WWW-Authenticate',
            },
          },
        );
      }

      // Fail fast on an invalid / rotated / expired token — never hang.
      const reqId = await peekRequestId(req);
      span.setAttributes({ 'auth.result': 'failed', 'http.response.status_code': 200 });
      return jsonrpcError(
        reqId,
        -32001,
        'Invalid, expired or unknown API token. Check the token in your LoreKit MCP server URL or config (it may have been rotated), or re-authorize from your MCP client.',
      );
    }

    span.setAttributes({
      'auth.result': 'ok',
      'auth.type': auth.type,
      ...(auth.userId ? { 'auth.user_id': auth.userId } : {}),
    });

    const adapter = resolveStorageAdapter();

    // Per-user request rate limit — transport layer, all MCP methods.
    // Service-role (CI/internal) is exempt; unauthenticated requests never
    // reach this point (handled above). BYOD adapters skip hosted rate limiting.
    if (auth.type !== 'service' && auth.userId && adapter.supportsRateLimit) {
      const db = getDb(auth);

      // Resolve the user's plan name once per request — used for rate-limit
      // messages and usage-event annotation. Fails open (null → 'free').
      const planName = await getUserPlanName(db, auth.userId);
      span.setAttributes({ 'lorekit.plan': planName ?? 'free' });

      const { allowed, retryAfterSeconds, currentCount, limitValue } = await checkRateLimit(db, auth.userId, span);
      span.setAttributes({
        'rate_limit.allowed': allowed,
        ...(currentCount != null ? { 'rate_limit.current_count': currentCount } : {}),
        ...(limitValue != null ? { 'rate_limit.limit_value': limitValue } : {}),
      });
      if (!allowed) {
        // Record rate-limit hit as a usage event for plan-sizing analytics.
        recordUsageEvent(db, {
          userId: auth.userId,
          planName,
          toolName: 'transport',
          authType: auth.type as 'api_key' | 'jwt',
          outcome: 'rate_limited',
        });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32029, message: rateLimitMessage(retryAfterSeconds) },
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) },
          },
        );
      }
    }

    return handleMcp(req, auth, span, adapter);
  });
});
