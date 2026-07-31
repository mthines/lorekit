import { NextResponse } from 'next/server';
import { generateSpec } from '@lorekit/schemas/openapi/spec';

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
 * `/api-docs/proxy` forwarder (see ../proxy/route.ts) to avoid CORS.
 */
const SUPABASE_URL =
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'https://pqokxlhvnosogizsjztg.supabase.co';
const BASE_URL = `${SUPABASE_URL}/functions/v1`;

export function GET() {
  const spec = generateSpec(BASE_URL);
  return NextResponse.json(spec, {
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60' },
  });
}
