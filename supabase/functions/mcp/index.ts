/**
 * LoreKit MCP Edge Function — entry point.
 *
 * Routes all requests to co-located handlers:
 *   auth.ts         — resolveAuth, getDb, canWrite, getUserId
 *   tools.ts        — memory.write/read/list/delete/search handlers
 *   webhook.ts      — GitHub PR comment → lesson creation
 *   mcp-handler.ts  — MCP JSON-RPC dispatcher (initialize, tools/list, tools/call)
 *
 * Observability via ../functions/_shared/otel.ts:
 *   traceRequest()           wraps each request in a root span
 *   createTracedClient()     creates child spans per Postgres query (in tools.ts)
 *
 * Required secrets (supabase secrets set --project-ref <ref>):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GITHUB_WEBHOOK_SECRET
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.europe-west4.gcp.dash0-dev.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 */

import { traceRequest } from '../_shared/otel.ts';
import { resolveAuth } from './auth.ts';
import { handleMcp, jsonrpcError } from './mcp-handler.ts';
import { handleWebhook } from './webhook.ts';

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

  // MCP endpoint — authenticate then dispatch
  return traceRequest(req, 'lorekit.mcp', async (span) => {
    const auth = await resolveAuth(req.headers.get('authorization'));
    if (!auth) return jsonrpcError(null, -32001, 'Unauthorized');

    span.setAttributes({
      'auth.type': auth.type,
      ...(auth.userId ? { 'auth.user_id': auth.userId } : {}),
    });

    return handleMcp(req, auth, span);
  });
});
