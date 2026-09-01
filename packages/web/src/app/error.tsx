'use client';

/**
 * Root error boundary — catches unhandled RSC and client errors.
 * Next.js renders this automatically when an error escapes all nested boundaries.
 * The `reset` prop re-runs the failed segment without a full page reload.
 */
import { useEffect } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, Home, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/Button';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Surface to browser console so Dash0 RUM can capture it
    console.error('[LoreKit error boundary]', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-6 bg-[var(--color-bg)]">
      {/* Ambient glow — very subtle, not distracting */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 flex items-center justify-center"
      >
        <div className="size-[400px] rounded-full bg-[var(--color-error)] opacity-[0.03] blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex w-full max-w-sm flex-col items-center gap-6 text-center"
      >
        {/* Icon */}
        <div className="flex size-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <AlertTriangle className="size-5 text-[var(--color-content-tertiary)]" aria-hidden />
        </div>

        {/* Message */}
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold text-[var(--color-content-primary)]">
            Something went wrong
          </h1>
          <p className="text-sm text-[var(--color-content-secondary)]">
            An error occurred loading this page. Retrying usually resolves it.
          </p>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-2">
          <Button variant="primary" fullWidth leftIcon={<RotateCcw className="size-4" />} onClick={reset}>
            Try again
          </Button>
          <Button
            variant="secondary"
            fullWidth
            href="/overview"
            leftIcon={<Home className="size-4" />}
          >
            Go to dashboard
          </Button>
        </div>

        {/* Digest — for support, intentionally de-emphasised */}
        {error.digest && (
          <p className="font-mono text-[10px] text-[var(--color-content-tertiary)]">
            {error.digest}
          </p>
        )}
      </motion.div>
    </div>
  );
}
