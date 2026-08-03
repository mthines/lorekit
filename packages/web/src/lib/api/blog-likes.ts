/**
 * The dashboard's client for the PUBLIC blog like counter (`blog` edge function).
 *
 * Like `memories.ts`, the blog like control is a client of LoreKit's own REST
 * API rather than a direct supabase-js query — the same rule the rest of the app
 * follows (see `packages/web/CLAUDE.md`). The one difference is that `/blog/likes`
 * is unauthenticated (the blog is public and likes are anonymous), so these go
 * through `publicRestFetch` with no token instead of `restFetch`.
 *
 * Types come from `@lorekit/schemas/blog`, so the client cannot invent a
 * parameter the endpoint does not accept.
 */

import type { BlogLikesResponse } from '@lorekit/schemas/blog';
import { clampLikeDelta } from '@/lib/blog/likes';
import { publicRestFetch } from './rest';

/** `GET /blog/likes?slug=…` — the post's current global like total. */
export function getBlogLikesRequest(slug: string, signal?: AbortSignal): Promise<BlogLikesResponse> {
  return publicRestFetch<BlogLikesResponse>('/blog/likes', {
    query: { slug },
    ...(signal ? { signal } : {}),
  });
}

/** `POST /blog/likes` — add `delta` likes; returns the new global total. */
export function addBlogLikesRequest(slug: string, delta: number): Promise<BlogLikesResponse> {
  return publicRestFetch<BlogLikesResponse>('/blog/likes', {
    method: 'POST',
    // Mirror the server's [1,100] clamp so the wire value is always valid.
    body: { slug, delta: clampLikeDelta(delta) },
  });
}
