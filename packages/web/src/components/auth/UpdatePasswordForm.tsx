'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import { reportAuthAttempt, reportAuthFailure, reportAuthSuccess } from '@/lib/auth-telemetry';
import { validatePasswordConfirmation } from '@/lib/password-policy';
import { DEFAULT_POST_LOGIN_PATH } from '@/lib/auth-redirect';
import { FIELD_CLASS } from './field-styles';

type SessionState = 'checking' | 'ready' | 'missing';

/**
 * Step 2 of password recovery: set the new password.
 *
 * By the time this renders, `/api/auth/callback` has already exchanged the
 * recovery code for a session, so this is a plain `updateUser` call. If the
 * session is missing (link expired, opened in a different browser, or the page
 * was visited directly) we say so and point back at the request form rather
 * than failing on submit.
 */
export function UpdatePasswordForm() {
  const router = useRouter();
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSessionState(data.session ? 'ready' : 'missing');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const policyError = validatePasswordConfirmation(password, confirmation);
    if (policyError) {
      setError(policyError);
      return;
    }

    setBusy(true);
    reportAuthAttempt('password_reset_complete');
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      reportAuthFailure('password_reset_complete', updateError);
      setError(friendlyAuthError(updateError));
      return;
    }
    reportAuthSuccess('password_reset_complete');
    setDone(true);
    router.push(DEFAULT_POST_LOGIN_PATH);
    router.refresh();
  }

  if (sessionState === 'checking') {
    return (
      <p role="status" className="text-sm text-[var(--color-content-secondary)]">
        Checking your link...
      </p>
    );
  }

  if (sessionState === 'missing') {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-red-400">
          This reset link is invalid, expired, or was already used.
        </p>
        <Link
          href="/forgot-password"
          className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)]"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
      <label htmlFor="lk-new-password" className="sr-only">
        New password
      </label>
      <input
        id="lk-new-password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        autoFocus
        required
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy || done}
        className={FIELD_CLASS}
      />

      <label htmlFor="lk-confirm-password" className="sr-only">
        Confirm new password
      </label>
      <input
        id="lk-confirm-password"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        required
        placeholder="Confirm new password"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        disabled={busy || done}
        className={FIELD_CLASS}
      />

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || done}
        aria-busy={busy}
        className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {done ? 'Password updated' : busy ? 'Updating...' : 'Update password'}
      </button>
    </form>
  );
}
