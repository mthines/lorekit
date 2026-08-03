// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/blog.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

/**
 * Schemas for the PUBLIC blog like counter (`blog` edge function).
 *
 * Unlike every other REST surface in this package, these back an
 * UNAUTHENTICATED endpoint: the blog is public and a like accumulates across
 * all anonymous visitors. There is no tenant and no owner — the counter is one
 * global total per post slug. The per-session cap (100) is a client concern;
 * the server only clamps a single call, which is why `delta` is bounded here
 * and again in the `lorekit_blog_like` RPC.
 */

/** The maximum likes one session may contribute to a post (client-enforced). */
export const BLOG_MAX_SESSION_LIKES = 100;

/**
 * A blog post slug — lowercase kebab-case, ≤128 chars. Matches the
 * `blog_post_likes.slug` CHECK and the `lorekit_blog_like` slug guard exactly,
 * so a malformed slug is a 400 at the edge rather than a raised RPC error.
 */
export const BlogSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case');

/** `GET /blog/likes?slug=…` query. */
export const GetBlogLikesQuerySchema = z.object({ slug: BlogSlugSchema });

/** `POST /blog/likes` body — like a post, by one (default) or a small batch. */
export const LikeBlogBodySchema = z.object({
  slug: BlogSlugSchema,
  delta: z.coerce.number().int().min(1).max(BLOG_MAX_SESSION_LIKES).optional().default(1),
});

/** `{ likes }` — a post's global like total. */
export const BlogLikesResponseSchema = z.object({ likes: z.number().int().nonnegative() });

export type GetBlogLikesQuery = z.infer<typeof GetBlogLikesQuerySchema>;
export type LikeBlogBody = z.infer<typeof LikeBlogBodySchema>;
export type BlogLikesResponse = z.infer<typeof BlogLikesResponseSchema>;
