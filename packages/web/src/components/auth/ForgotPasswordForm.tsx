'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { addSignalAttribute } from '@dash0/sdk-web';
import { friendlyAuthError } from '@/lib/auth-errors';
import { authCallbackOrigin, buildAuthCallbackUrl } from '@/lib/auth-callback-url';

/**
 * Step 1 of password recovery: ask Supabase to email a recovery link.
 *
 * The link returns to `/api/auth/callback?next=/update-password`, so the
 * existing callback route exchanges the recovery code for a session and the
 * user lands on the update-password form already authenticated.
 *
 * The confirmation copy is deliberately identical whether or not an account
 * exists for the address — `resetPasswordForEmail` succeeds either way, and
 * saying "no such account" would turn this form into an enumeration oracle.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Please enter your email address.');
      return;
    }

    setBusy(true);
    addSignalAttribute('auth.method', 'password_reset_request');
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo: buildAuthCallbackUrl(authCallbackOrigin(), '/update-password'),
    });
    setBusy(false);
    if (resetError) {
      addSignalAttribute(
        'auth.password_error_code',
        resetError.code ?? resetError.name ?? 'unknown',
      );
      setError(friendlyAuthError(resetError));
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-content-primary)]">Check your inbox</p>
        <p className="text-xs text-[var(--color-content-secondary)]">
          If an account exists for{' '}
          <span className="font-medium text-[var(--color-content-primary)]">{email.trim()}</span>,
          we&apos;ve sent a link to reset its password. The link expires in one hour.
        </p>
        <Link
          href="/login"
          className="text-xs text-[var(--color-content-tertiary)] underline-offset-2 hover:text-[var(--color-content-secondary)] hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
      <label htmlFor="lk-reset-email" className="sr-only">
        Email address
      </label>
      <input
        id="lk-reset-email"
        name="email"
        type="email"
        autoComplete="email"
        autoFocus
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
        className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50"
      />
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Sending...' : 'Send reset link'}
      </button>
      <Link
        href="/login"
        className="text-center text-xs text-[var(--color-content-tertiary)] underline-offset-2 hover:text-[var(--color-content-secondary)] hover:underline"
      >
        Back to sign in
      </Link>
    </form>
  );
}
