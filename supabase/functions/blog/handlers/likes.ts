import type { DbClient } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery, validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { GetBlogLikesQuerySchema, LikeBlogBodySchema } from '../../_shared/schemas/blog.ts';

/** Coerce a bigint-or-number-or-string count into a safe non-negative integer. */
function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * The one route in this codebase whose response is safe to cache, and the
 * reasoning is worth stating because nothing else here qualifies.
 *
 * It is PUBLIC and anonymous — no `resolveRestAuth`, no Bearer token, no tenant
 * (see `blog/index.ts`) — so a cached body cannot leak one caller's data to
 * another. `corsResponseHeaders` already emits `Vary: Origin`, which is what
 * makes a shared cache safe despite the origin-specific
 * `Access-Control-Allow-Origin` (see `cors-origins.ts`, where that header is
 * documented as mandatory for exactly this reason).
 *
 * Staleness is bounded and harmless: the counter is a blog vanity metric, and
 * the ONE reader (`components/blog/PostLikes.tsx`) fetches it once on mount and
 * then tracks its own likes from the POST response, never re-issuing the GET.
 * WITHIN a page view that makes the visitor's own clicks exact — the total they
 * watch is the one the POST returned, which no cache sits in front of.
 *
 * ACROSS page views the guarantee is weaker, and it is worth being precise
 * about why: the mount GET can be served by a shared cache populated before the
 * visitor's like landed, so a revisit inside `s-maxage` can show a total
 * missing their own click. That is bounded by the directive below and self-heals
 * on the next revalidation, and it is the honest cost of caching a global
 * counter — it is NOT prevented by the client's `cache: 'no-store'`, which only
 * rules out the visitor's OWN cache, and it is the reason a browser `max-age`
 * would make this strictly worse rather than merely redundant.
 *
 * WHAT THIS DOES AND DOES NOT FIX. The endpoint shows ~660 ms average latency
 * in production, but the query behind it is a primary-key lookup on a
 * single-column-keyed table of a few rows (`blog_post_likes.slug` is the PK,
 * migration 00055) — that is not query time. At a handful of calls a day the
 * isolate is cold on essentially every request, so the cost is invocation
 * overhead: cold start plus the first PostgREST connection. Caching cannot make
 * a cold start faster; what it does is stop the request reaching the function
 * at all on a revisit, which is the only lever that helps when the cost is
 * per-invocation rather than per-row. Do not read this as a database fix.
 *
 * THIS IS A SHARED-CACHE DIRECTIVE ONLY — deliberately no browser `max-age`.
 * The sole caller, `publicRestFetch` (`packages/web/src/lib/api/rest.ts`),
 * sends `cache: 'no-store'`, so the browser neither stores nor reuses this
 * response and any private freshness lifetime here would be dead weight —
 * `max-age=0` says so explicitly rather than leaving a heuristic to guess one.
 * The win therefore comes from `s-maxage` / `stale-while-revalidate` at a
 * shared cache in front of the function, never from the visitor's own cache.
 * Do not add a `max-age` back without first changing that fetch, and read the
 * staleness note above before you do.
 */
const LIKES_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=900';

/** `GET /blog/likes?slug=…` → `{ likes }`, the post's global total (0 if none). */
export async function handleGetLikes(
  req: Request, db: DbClient, span: Span, cors: Record<string, string>,
): Promise<Response> {
  const v = validateQuery(req, GetBlogLikesQuerySchema, cors);
  if (!v.ok) return v.response;

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .from('blog_post_likes')
    .select('likes')
    .eq('slug', v.data.slug)
    .maybeSingle();
  if (error) { span.error(error.message); throw error; }

  return ok(
    { likes: data ? toCount((data as { likes: unknown }).likes) : 0 },
    { ...cors, 'Cache-Control': LIKES_CACHE_CONTROL },
  );
}

/** `POST /blog/likes` `{ slug, delta? }` → `{ likes }`, the new global total. */
export async function handleAddLike(
  req: Request, db: DbClient, span: Span, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, LikeBlogBodySchema, cors);
  if (!v.ok) return v.response;

  const tracedDb = createTracedClient(db, span);
  // The RPC clamps p_delta to [1,100] and validates the slug again — the schema
  // above is the first gate, the RPC the authoritative one.
  const { data, error } = await tracedDb.rpc('lorekit_blog_like', {
    p_slug: v.data.slug,
    p_delta: v.data.delta,
  });
  if (error) { span.error(error.message); throw error; }

  // Explicitly uncacheable. A POST is not cacheable by default, but this
  // response is the caller's own post-increment total and the GET beside it now
  // carries a `public` directive — being explicit here keeps an intermediary
  // from ever treating the two as interchangeable.
  return ok({ likes: toCount(data) }, { ...cors, 'Cache-Control': 'no-store' });
}
