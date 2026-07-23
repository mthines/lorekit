/**
 * Global 404 page — rendered when Next.js can't match a route.
 * Server component (no 'use client') — cannot use hooks here.
 */
import Link from 'next/link';
import { Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 bg-[var(--color-bg)]">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="font-mono text-5xl font-bold text-[var(--color-content-tertiary)]">
          404
        </span>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            Page not found
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            The page you&apos;re looking for doesn&apos;t exist.
          </p>
        </div>
      </div>
      <Link
        href="/dashboard"
        className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
      >
        <Home className="size-4" aria-hidden />
        Go to dashboard
      </Link>
    </div>
  );
}
