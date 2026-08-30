'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampSessionLikes,
  isSessionMaxed,
  parseSessionLikes,
  sessionLikesKey,
} from '@/lib/blog/likes';
import { addBlogLikesRequest, getBlogLikesRequest } from '@/lib/api/blog-likes';
import { LikeButton } from './LikeButton';

/**
 * Data + interaction wiring for the blog like counter.
 *
 * The presses are OPTIMISTIC: each accepted tap bumps the visible total
 * instantly (so a rapid-tap burst feels alive) and adds to a pending delta that
 * is FLUSHED to the server on a short debounce. Batching turns a flurry of taps
 * into one write, and the authoritative total the flush returns folds in any
 * likes other visitors landed meanwhile — reconciled with whatever is still
 * pending locally so a click mid-flush is never dropped.
 *
 * The per-session cap lives in `localStorage`, keyed per slug: an anonymous
 * visitor has no server identity, so this is where "100 per user/session" is
 * enforced. The server independently clamps a single call to the same ceiling.
 */

/** How long after the last tap to flush the accumulated delta to the server. */
const FLUSH_DELAY_MS = 600;

export function PostLikes({ slug }: { slug: string }) {
  const [count, setCount] = useState(0);
  const [sessionLikes, setSessionLikes] = useState(0);
  const [loading, setLoading] = useState(true);

  const pendingDelta = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The write currently in flight — a second flush queues behind it. */
  const inFlight = useRef<Promise<void> | null>(null);

  const flush = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }

    // Writes are SERIALISED. A tap 600ms into a slow write must not start a
    // second one: the two totals resolve in arbitrary order, and the later
    // `setCount` can be the one carrying the smaller total, so the visible
    // count regresses. Queueing (rather than dropping the second flush) also
    // means nothing is stranded — whatever is pending when the in-flight write
    // lands is picked up by this call, with no timer left to arm.
    const queued = (inFlight.current ?? Promise.resolve()).then(async () => {
      const delta = pendingDelta.current;
      if (delta <= 0) return;
      pendingDelta.current = 0;

      try {
        const { likes } = await addBlogLikesRequest(slug, delta);
        // Fold in any taps that arrived while the write was in flight, so the
        // authoritative total never clobbers an unsent optimistic increment.
        setCount(likes + pendingDelta.current);
      } catch {
        // The REST call threw (offline, cold function, 4xx). A like is a vanity
        // metric — never surface an error; hand the delta back so the next tap,
        // tab-hide, or unmount re-sends it (the session cap already charged for
        // it, and the optimistic count already shows it). Swallowed so the queue
        // never becomes a rejected promise every later flush would inherit.
        pendingDelta.current += delta;
      }
    });
    inFlight.current = queued;
    return queued;
  }, [slug]);

  // Load the global total and this session's prior contribution on mount.
  useEffect(() => {
    let active = true;
    setSessionLikes(parseSessionLikes(readStored(slug)));
    getBlogLikesRequest(slug)
      .then(({ likes }) => {
        if (active) setCount(likes);
      })
      .catch(() => {
        // Offline / cold function — show 0 rather than an error; a like still
        // works and reconciles on the next successful flush.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  // Flush any pending likes when the tab is hidden or the component unmounts, so
  // a reader who leaves right after tapping still has their likes recorded.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
    };
  }, [flush]);

  const handleLike = useCallback(() => {
    if (isSessionMaxed(sessionLikes)) return;

    setCount((c) => c + 1);
    setSessionLikes((s) => {
      const next = clampSessionLikes(s + 1);
      writeStored(slug, next);
      return next;
    });

    pendingDelta.current += 1;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }, [flush, sessionLikes, slug]);

  return (
    <section className="mt-16 border-t border-[var(--color-border)] pt-10" aria-label="Like this post">
      <LikeButton count={count} sessionLikes={sessionLikes} onLike={handleLike} loading={loading} />
    </section>
  );
}

/** Read this session's stored like count, tolerating unavailable storage. */
function readStored(slug: string): string | null {
  try {
    return window.localStorage.getItem(sessionLikesKey(slug));
  } catch {
    return null;
  }
}

/** Persist this session's like count, silently ignoring storage failures. */
function writeStored(slug: string, value: number): void {
  try {
    window.localStorage.setItem(sessionLikesKey(slug), String(value));
  } catch {
    // Private mode / blocked storage — the cap simply resets on reload.
  }
}
