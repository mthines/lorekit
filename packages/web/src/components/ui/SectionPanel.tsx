'use client';

import type { ReactNode } from 'react';
import { motion, MotionConfig } from 'motion/react';

interface SectionPanelProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/**
 * Reusable titled content card: a bordered panel with an amber icon chip header
 * and a quick fade-up entrance. Pair with {@link SectionNav} so every section
 * across the app shares the same chrome and adding one is drop-in.
 */
export function SectionPanel({ icon, title, subtitle, children }: SectionPanelProps) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] p-4">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
            aria-hidden
          >
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--color-content-primary)]">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-content-secondary)]">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <div className="p-4">{children}</div>
      </motion.section>
    </MotionConfig>
  );
}
