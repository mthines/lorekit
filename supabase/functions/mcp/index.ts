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
    // POST-only, checked BEFORE authentication.
    //
    // A request's method is knowable from the request line alone — nothing
    // about "GET is not supported here" depends on who is asking. This guard
    // used to live at the top of `handleMcp`, which meant every SSE-transport
    // probe (`GET /mcp` is the first thing such a client sends) paid the full
    // authenticated preamble — a token lookup, a plan lookup and a rate-limit
    // RPC, ~319 ms of fixed cost — to receive a constant 405.
    //
    // Answering early also means an unauthenticated GET flood costs no database
    // work at all. It stays inside `traceRequest`, so the probe is still one
    // span and remains countable.
    //
    // `clientError` (not `error`) — a client probing for SSE against a server
    // that does not offer it is behaving reasonably; OTel marks a server span
    // ERROR only for 5xx faults.
    if (req.method !== 'POST') {
      span.clientError(`MethodNotAllowed: ${req.method} is not supported; use POST`).setAttributes({
        'mcp.method': 'unknown',
      });
      // Name the protocol version this server actually negotiates, not a
      // transport name. `initialize` answers `protocolVersion: '2024-11-05'`
      // (mcp-handler.ts), whose transport is HTTP+SSE — so telling a client it
      // is talking to Streamable HTTP contradicts the handshake the same server
      // performs one request later. What is true regardless of version, and is
      // the only thing the probing client needs, is: POST only.
      return new Response(
        JSON.stringify({
          error:
            'Method Not Allowed. This MCP server uses POST (protocol 2024-11-05); GET/SSE is not supported.',
        }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST' },
        },
      );
    }

    // resolveAuth checks Authorization header first, then ?token= query param as fallback.
    // Pass the root span so auth outcome attributes (auth.type, auth.outcome,
    // auth.user_id) land on the request span — no separate child span needed.
    const auth = await resolveAuth(req.headers.get('authorization'), url.searchParams.get('token'), span);
    if (!auth) {
      // Fail fast on a missing / invalid / rotated token — never hang. Return
      // the error IN-BAND: HTTP 200 (not 401) with a JSON-RPC error carrying the
      // REAL request id. A 401 makes streamable-HTTP clients (mcp-remote) treat
      // it as a session-auth failure and stall; an id:null body can't be matched
      // to the pending tools/call and also hangs — so we peek the id and echo it.
      // This is a token-based server with no OAuth flow for a 401 to drive.
      const reqId = await peekRequestId(req);
      span.setAttributes({ 'auth.result': 'failed', 'http.response.status_code': 200 });
      return jsonrpcError(
        reqId,
        -32001,
        'Invalid or unknown API token. Check the token in your LoreKit MCP server URL or config (it may have been rotated).',
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
      //
      // Issued CONCURRENTLY with the rate-limit check, not before it. Both are
      // keyed only on `auth.userId` and neither reads the other's result, so
      // awaiting them in sequence bought nothing and put TWO serial Supabase
      // round-trips in front of every MCP message — including the ones that go
      // on to do no work at all (`notifications/initialized` answers 204). This
      // is the same reasoning `_shared/api/router.ts` already applies to the
      // REST surface, where the plan lookup is deliberately not awaited inline;
      // the MCP transport was the surface that still paid for it serially.
      // `getUserPlanName` fails open to null and `checkRateLimit` fails open to
      // allowed, so neither promise rejects and `Promise.all` cannot reject.
      const [planName, rateLimit] = await Promise.all([
        getUserPlanName(db, auth.userId, span),
        checkRateLimit(db, auth.userId, span),
      ]);
      span.setAttributes({ 'lorekit.plan': planName ?? 'free' });

      const { allowed, retryAfterSeconds, currentCount, limitValue } = rateLimit;
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
