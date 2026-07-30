'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import { MIN_PASSWORD_LENGTH, validatePasswordConfirmation } from '@/lib/password-policy';

/**
 * Set-or-change-password panel for /settings/user.
 *
 * The same `updateUser({ password })` call covers both cases, so there is one
 * form rather than two: an account created through GitHub OAuth or a magic
 * link uses it to *add* a password (which is what makes email + password
 * sign-in reachable for existing users), and an account that already has one
 * uses it to rotate it.
 */
export function PasswordPanel() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    const policyError = validatePasswordConfirmation(password, confirmation);
    if (policyError) {
      setError(policyError);
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(friendlyAuthError(updateError));
      return;
    }
    setPassword('');
    setConfirmation('');
    setSuccess('Password updated. You can now sign in with your email and this password.');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Set a password to sign in with your email address, or change the one you already have.
        Minimum {MIN_PASSWORD_LENGTH} characters. GitHub and magic-link sign-in keep working either
        way.
      </p>

      <label htmlFor="lk-settings-password" className="sr-only">
        New password
      </label>
      <input
        id="lk-settings-password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        required
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        className="h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50"
      />

      <label htmlFor="lk-settings-password-confirm" className="sr-only">
        Confirm new password
      </label>
      <input
        id="lk-settings-password-confirm"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        required
        placeholder="Confirm new password"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        disabled={busy}
        className="h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50"
      />

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-xs text-[var(--color-success)]">
          {success}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <KeyRound className="size-4 shrink-0" aria-hidden />
        {busy ? 'Saving...' : 'Save password'}
      </button>
    </form>
  );
}
