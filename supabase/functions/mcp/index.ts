/**
 * Supabase Edge Function wrapper for LoreKit MCP server.
 * Deployed via: supabase functions deploy mcp
 *
 * Note: Edge Functions run in Deno, but the Node.js OTel SDK cannot be initialised here.
 * OTel telemetry in this deployment path is handled via environment-variable-based
 * auto-instrumentation if a compatible runtime is available, or omitted for cold-start
 * performance. For full OTel coverage, deploy packages/mcp-server to Fly.io instead.
 */

import { resolveAuth, unauthorizedResponse } from '../../packages/mcp-server/src/auth.ts';
import { handleMcpRequest } from '../../packages/mcp-server/src/server.ts';
import { handleGitHubWebhook } from '../../packages/mcp-server/src/webhooks/github.ts';

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith('/mcp')) {
    const auth = await resolveAuth(req.headers.get('authorization') ?? undefined);
    if (!auth) return unauthorizedResponse();
    return handleMcpRequest(req, auth);
  }

  if (url.pathname.endsWith('/webhooks/github')) {
    return handleGitHubWebhook(req);
  }

  if (url.pathname.endsWith('/healthz')) {
    return new Response('ok', { status: 200 });
  }

  return new Response('Not Found', { status: 404 });
});
