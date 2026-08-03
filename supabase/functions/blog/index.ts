import { createClient } from 'npm:@supabase/supabase-js@2';
import { traceRequest } from '../_shared/otel.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { notFound, methodNotAllowed, internalError } from '../_shared/api/respond.ts';
import { relativePath } from '../_shared/api/router.ts';
import { handleGetLikes, handleAddLike } from './handlers/likes.ts';

/**
 * blog — the PUBLIC blog like counter (`/blog/likes`).
 *
 * This is the ONE REST function that does not call `resolveRestAuth`: the blog
 * is a public, unauthenticated page and a like accumulates across all anonymous
 * visitors, so there is no Bearer token to resolve and no tenant to scope to.
 * It therefore does not use the shared `createRouter` (whose whole purpose is
 * per-tier permission gating + per-user usage events) — it has its own tiny
 * dispatch for the two like operations.
 *
 * It talks to Postgres with the SERVICE_ROLE key because there is no user
 * session to run under. That is safe here precisely because the surface is so
 * small: the only two operations exposed are reading and incrementing one
 * global counter, both slug-validated by `@lorekit/schemas/blog` and the delta
 * clamped by the `lorekit_blog_like` RPC — there is no tenant data to leak.
 *
 * Requires `verify_jwt = false` in config.toml (like `health` / `openapi`).
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);

  return traceRequest(req, 'lorekit.blog', async (span) => {
    span.setAttributes({ 'lorekit.function': 'blog', 'faas.name': 'blog' });

    const rel = relativePath(new URL(req.url).pathname, 'blog');
    if (rel !== '/likes') return notFound('Route', cors);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      if (req.method === 'GET') return await handleGetLikes(req, db, span, cors);
      if (req.method === 'POST') return await handleAddLike(req, db, span, cors);
      return methodNotAllowed(cors);
    } catch (e) {
      span.error(`Unhandled: ${(e as Error).message}`);
      return internalError(cors);
    }
  });
});
