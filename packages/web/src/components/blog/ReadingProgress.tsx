'use client';

import { motion, useScroll, useSpring } from 'motion/react';

/**
 * A hairline reading-progress bar pinned to the top of the viewport that fills as
 * the reader moves through the post. Composite-only — it animates `transform:
 * scaleX` (GPU), never width — and is driven by scroll position, so it reflects
 * state rather than playing autonomous motion. A light spring smooths the fill;
 * the `scaleX` origin is the inline-start edge.
 */
export function ReadingProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.3 });

  return (
    <motion.div
      aria-hidden
      style={{ scaleX }}
      className="fixed inset-x-0 top-0 z-40 h-0.5 origin-left bg-[var(--color-accent)]"
    />
  );
}
