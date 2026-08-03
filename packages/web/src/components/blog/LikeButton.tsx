'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import { motion, useAnimate, useReducedMotion } from 'motion/react';
import {
  MAX_SESSION_LIKES,
  formatLikeCount,
  isSessionMaxed,
  warmthRatio,
} from '@/lib/blog/likes';

/**
 * The blog "like" control — a heart pill a reader can tap up to 100 times, with
 * the running global total beside it.
 *
 * Presentational and CONTROLLED: it owns the delight (the press pop, the
 * particle burst, the warmth that builds toward the cap) but never the data.
 * The parent (`PostLikes`) passes the global `count` and this session's
 * `sessionLikes` and receives an `onLike` on each accepted press, so the
 * component is trivially storyable with mock handlers and has no Supabase or
 * `localStorage` knowledge of its own.
 *
 * Motion is composite-only (`transform`/`opacity`) and gated on
 * `prefers-reduced-motion`: reduced readers keep the colour, count, and haptic
 * feedback but lose the pop and the burst. See `/animations` intensity ladder —
 * this is a rung-1/2 confirmation, not a hero moment.
 */

interface LikeButtonProps {
  /** Global like total across all visitors. */
  count: number;
  /** How many likes THIS session has contributed (0..100). */
  sessionLikes: number;
  /** Fired once per accepted press (ignored when loading or capped). */
  onLike: () => void;
  /** True while the initial global count is still loading. */
  loading?: boolean;
}

/** One radial burst of hearts that flings outward and fades, then self-clears. */
function Burst({ id, onDone }: { id: number; onDone: (id: number) => void }) {
  // Six particles on a hexagon, each nudged by a per-burst offset so repeated
  // taps don't stamp the identical shape.
  const particles = useMemo(() => {
    const spread = (id % 6) * 12;
    return Array.from({ length: 6 }, (_, i) => {
      const angle = ((i * 60 + spread) * Math.PI) / 180;
      const distance = 26 + (i % 2) * 10;
      return { dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance };
    });
  }, [id]);

  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
      {particles.map((p, i) => (
        <motion.span
          key={i}
          className="absolute"
          initial={{ x: 0, y: 0, scale: 0.4, opacity: 0.9 }}
          animate={{ x: p.dx, y: p.dy, scale: 0, opacity: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          onAnimationComplete={i === 0 ? () => onDone(id) : undefined}
        >
          <Heart className="size-2.5 fill-[var(--color-accent)] text-[var(--color-accent)]" />
        </motion.span>
      ))}
    </span>
  );
}

export function LikeButton({ count, sessionLikes, onLike, loading = false }: LikeButtonProps) {
  const reduced = useReducedMotion();
  const [scope, animate] = useAnimate();
  const [bursts, setBursts] = useState<number[]>([]);
  const nextBurstId = useRef(0);

  const maxed = isSessionMaxed(sessionLikes);
  const liked = sessionLikes > 0;
  const warmth = warmthRatio(sessionLikes);

  const removeBurst = useCallback((id: number) => {
    setBursts((prev) => prev.filter((b) => b !== id));
  }, []);

  const handlePress = useCallback(() => {
    if (loading || maxed) return;
    onLike();

    // Light haptic on capable devices — kept even under reduced motion.
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }

    if (reduced) return;

    // Pop the heart and the number; spawn a burst.
    animate('.like-heart', { scale: [1, 1.3, 1] }, { duration: 0.26, ease: 'easeOut' });
    animate('.like-count', { scale: [1, 1.16, 1] }, { duration: 0.22, ease: 'easeOut' });
    const id = nextBurstId.current++;
    setBursts((prev) => [...prev, id]);
  }, [animate, loading, maxed, onLike, reduced]);

  const label = maxed
    ? `You've given all ${MAX_SESSION_LIKES} likes. ${count} likes total.`
    : `Like this post. ${count} ${count === 1 ? 'like' : 'likes'} so far.`;

  const caption = maxed
    ? `You've given all ${MAX_SESSION_LIKES} likes — thank you! 💛`
    : liked
      ? `You've liked this ${sessionLikes} ${sessionLikes === 1 ? 'time' : 'times'}.`
      : 'Enjoyed this? Show some love.';

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        ref={scope}
        type="button"
        onClick={handlePress}
        disabled={loading || maxed}
        aria-label={label}
        className="group relative inline-flex min-h-11 items-center gap-2.5 rounded-full border border-[var(--color-border)] px-5 py-2 text-[var(--color-content-secondary)] transition-[transform,border-color] duration-200 hover:-translate-y-px hover:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] active:translate-y-0 disabled:cursor-default disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        style={{
          backgroundColor: `color-mix(in srgb, var(--color-accent-subtle) ${warmth * 100}%, var(--color-bg-elevated))`,
        }}
      >
        {/* Accent glow that intensifies toward the cap — opacity-only, so it
            composites on the GPU and never repaints on a per-frame basis. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full transition-opacity duration-300"
          style={{ opacity: warmth, boxShadow: '0 0 22px 2px var(--color-accent-glow)' }}
        />

        <span className="relative grid place-items-center">
          <Heart
            className={`like-heart size-5 transition-colors duration-200 ${
              liked
                ? 'fill-[var(--color-accent)] text-[var(--color-accent)]'
                : 'text-[var(--color-content-secondary)] group-hover:text-[var(--color-accent)]'
            }`}
          />
          {bursts.map((id) => (
            <Burst key={id} id={id} onDone={removeBurst} />
          ))}
        </span>

        {loading ? (
          <span
            aria-hidden
            className="h-4 w-8 animate-pulse rounded bg-[var(--color-border)]"
          />
        ) : (
          <span className="like-count min-w-[1.5ch] text-sm font-semibold tabular-nums text-[var(--color-content-primary)]">
            {formatLikeCount(count)}
          </span>
        )}
      </button>

      <p
        className={`text-center font-mono text-xs ${
          maxed ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-tertiary)]'
        }`}
      >
        {caption}
      </p>

      {/* Announces the cap once for screen-reader users without spamming on
          every press (the button's own label carries the running count). */}
      <span role="status" aria-live="polite" className="sr-only">
        {maxed ? `Maximum of ${MAX_SESSION_LIKES} likes reached.` : ''}
      </span>
    </div>
  );
}
