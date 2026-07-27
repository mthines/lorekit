'use client';

import type { ReactNode } from 'react';
import { motion, MotionConfig } from 'motion/react';

interface TutorialCardProps {
  children: ReactNode;
}

/**
 * TutorialCard — the card wrapper for all Learn sub-pages.
 *
 * Matches the visual language of {@link SectionPanel} (same border token,
 * same bg-raised surface, same rounded-xl radius) without the icon-chip header
 * pattern that Settings pages use. Learn pages own their own h2 + description
 * header inside the card, so the wrapper is intentionally minimal.
 *
 * The `motion` fade-up entrance mirrors SectionPanel exactly (opacity 0→1,
 * y 6→0, 150 ms, expo-out easing) so navigating between Settings and Getting
 * started feels consistent. `MotionConfig reducedMotion="user"` honours
 * `prefers-reduced-motion` automatically.
 */
export function TutorialCard({ children }: TutorialCardProps) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.article
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      >
        <div className="p-6">
          {children}
        </div>
      </motion.article>
    </MotionConfig>
  );
}
