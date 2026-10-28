import { NextResponse } from 'next/server';

import { API_DOCS_CACHE_CONTROL, restApiSpec } from '@/lib/api-docs/rest-api';

/**
 * Serves the OpenAPI spec for the /api-docs Scalar page.
 *
 * Generated in-process from `@lorekit/schemas` (the single source of truth the
 * Supabase `openapi` Edge Function also uses) rather than fetched from the live
 * function. This means every spec edit — tags, descriptions, security — shows up
 * immediately in local dev with no redeploy, and there is no cross-origin hop.
 *
 * `servers[0].url` is pinned to this environment's Edge Function base so Scalar's
 * "Send" targets the right API; those requests still go through the same-origin
 * `/api-docs/proxy` forwarder (see ../proxy/route.ts) to avoid CORS. The same
 * document, rendered as Markdown for agents, is served at `/api-docs.md`.
 */
export function GET() {
  return NextResponse.json(restApiSpec(), {
    headers: { 'Cache-Control': API_DOCS_CACHE_CONTROL },
  });
}
