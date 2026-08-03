'use server';

import { createServerClient } from '@/lib/supabase/server';
import { clampLikeDelta } from './likes';

/**
 * Server actions backing the blog like counter.
 *
 * The blog is public and unauthenticated, so these run under the anonymous
 * Supabase role: the read is a plain SELECT under `blog_post_likes`'s public
 * read policy, and the write is the SECURITY DEFINER `lorekit_blog_like` RPC
 * granted to `anon` (migration 00055). No user JWT, no API token — the counter
 * is global per post slug and deliberately owner-less.
 *
 * Both fail SOFT: a like is a vanity metric, never worth surfacing an error over
 * a signed-out or offline visitor. `getPostLikes` degrades to 0 and `addPostLikes`
 * degrades to the last known total, so the optimistic UI reconciles on the next
 * successful flush instead of showing an error state.
 */

/** Coerce a bigint-or-number-or-string PostgREST value into a safe count. */
function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Current global like total for a post, or 0 when unknown. */
export async function getPostLikes(slug: string): Promise<number> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('blog_post_likes')
    .select('likes')
    .eq('slug', slug)
    .maybeSingle();
  if (error || !data) return 0;
  return toCount((data as { likes: unknown }).likes);
}

/**
 * Add `delta` likes to a post and return the new global total. The delta is
 * clamped to a single valid session's worth [1, 100] before it reaches the RPC,
 * which clamps again authoritatively.
 */
export async function addPostLikes(slug: string, delta: number): Promise<number> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc('lorekit_blog_like', {
    p_slug: slug,
    p_delta: clampLikeDelta(delta),
  });
  // On failure, read back the current total so the optimistic client corrects
  // itself rather than trusting its local guess.
  if (error) return getPostLikes(slug);
  return toCount(data);
}
