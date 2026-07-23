import type { Metadata } from 'next';
import { LoginButton } from '@/components/auth/LoginButton';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      {/* Background glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 flex items-center justify-center"
      >
        <div className="size-[600px] rounded-full bg-[var(--color-accent-glow)] blur-[120px]" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-6 text-center">
        {/* Logo mark */}
        <div className="flex size-14 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <span className="text-2xl" aria-hidden>⚡</span>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-content-primary)]">
            LoreKit
          </h1>
          <p className="max-w-xs text-sm text-[var(--color-content-secondary)]">
            Shared, persistent memory for your AI coding agents.
          </p>
        </div>

        <LoginButton />

        <p className="text-xs text-[var(--color-content-tertiary)]">
          Authenticates via GitHub OAuth. No password required.
        </p>
      </div>
    </main>
  );
}
