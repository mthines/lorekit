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

  return ok({ likes: data ? toCount((data as { likes: unknown }).likes) : 0 }, cors);
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

  return ok({ likes: toCount(data) }, cors);
}
