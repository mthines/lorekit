'use client';

/**
 * Dashboard error boundary — catches errors in any dashboard route
 * (overview, lore explorer, activity) before they reach the root boundary.
 * More contextual than the root error: the sidebar stays visible so the
 * user can navigate to another section without losing their session.
 */
import { useEffect } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const PAGE_LABELS: Record<string, string> = {
  '/dashboard': 'the overview',
  '/lore': 'the Lore Explorer',
  '/activity': 'the Activity feed',
};

export default function DashboardError({ error, reset }: ErrorProps) {
  const pathname = usePathname();
  const pageLabel = PAGE_LABELS[pathname] ?? 'this page';

  useEffect(() => {
    console.error('[LoreKit dashboard error boundary]', error);
  }, [error]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center"
    >
      {/* Icon */}
      <div className="flex size-10 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <AlertTriangle className="size-4 text-[var(--color-content-tertiary)]" aria-hidden />
      </div>

      {/* Message */}
      <div className="flex max-w-xs flex-col gap-1.5">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">
          Couldn&apos;t load {pageLabel}
        </p>
        <p className="text-xs text-[var(--color-content-tertiary)]">
          Something went wrong on the server. Retrying usually resolves it.
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-content-primary)] px-4 text-sm font-medium text-[var(--color-bg)] transition-opacity duration-150 hover:opacity-90"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </button>
        <Link
          href="/dashboard"
          className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)]"
        >
          Overview
        </Link>
      </div>

      {/* Digest — subtle, for support */}
      {error.digest && (
        <p className="font-mono text-[10px] text-[var(--color-content-tertiary)]">
          {error.digest}
        </p>
      )}
    </motion.div>
  );
}
