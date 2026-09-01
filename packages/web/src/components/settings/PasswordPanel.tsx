'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import { reportAuthAttempt, reportAuthFailure, reportAuthSuccess } from '@/lib/auth-telemetry';
import { MIN_PASSWORD_LENGTH, validatePasswordConfirmation } from '@/lib/password-policy';
import { Button } from '@/components/ui/Button';

const LABEL_CLASS = 'text-xs font-medium text-[var(--color-content-secondary)]';

const INPUT_CLASS =
  'h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50';

/**
 * Set-or-change-password form for /settings/user.
 *
 * The same `updateUser({ password })` call covers both cases, so there is one
 * form rather than two: an account created through GitHub OAuth or a magic
 * link uses it to *add* a password (which is what makes email + password
 * sign-in reachable for existing users), and an account that already has one
 * uses it to rotate it.
 *
 * The panel deliberately does not claim whether a password is already set —
 * Supabase gives the client no reliable signal for that (a magic-link account
 * also carries an `email` identity), and guessing would be worse than staying
 * neutral.
 */
export function PasswordPanel() {
  const passwordId = useId();
  const confirmId = useId();
  const hintId = useId();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  /** Clear a stale result as soon as the user starts a new attempt. */
  function onEdit(setter: (value: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value);
      if (error) setError('');
      if (success) setSuccess('');
    };
  }

  /**
   * Validate when the user leaves the confirmation field rather than on every
   * keystroke — mid-typing a matching password always looks like a mismatch,
   * and flagging that is noise.
   */
  function handleConfirmationBlur() {
    if (!password || !confirmation) return;
    const problem = validatePasswordConfirmation(password, confirmation);
    if (problem) setError(problem);
  }

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
    reportAuthAttempt('password_change_settings');
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      reportAuthFailure('password_change_settings', updateError);
      setError(friendlyAuthError(updateError));
      return;
    }
    reportAuthSuccess('password_change_settings');
    setPassword('');
    setConfirmation('');
    setRevealed(false);
    setSuccess('Password updated. You can now sign in with your email and this password.');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={passwordId} className={LABEL_CLASS}>
          New password
        </label>
        <div className="relative">
          <input
            id={passwordId}
            name="new-password"
            type={revealed ? 'text' : 'password'}
            autoComplete="new-password"
            required
            aria-describedby={hintId}
            value={password}
            onChange={onEdit(setPassword)}
            disabled={busy}
            className={`${INPUT_CLASS} pr-12`}
          />
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            // A changing accessible name, deliberately without `aria-pressed`:
            // pairing the two makes a screen reader announce both the label and
            // a pressed state, which contradict each other half the time.
            aria-label={revealed ? 'Hide password' : 'Show password'}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-[var(--color-content-tertiary)] transition-colors hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]"
          >
            {revealed ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </button>
        </div>
        <p id={hintId} className="text-xs text-[var(--color-content-tertiary)]">
          At least {MIN_PASSWORD_LENGTH} characters. GitHub and magic-link sign-in keep working
          either way.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={confirmId} className={LABEL_CLASS}>
          Confirm new password
        </label>
        <input
          id={confirmId}
          name="confirm-password"
          type={revealed ? 'text' : 'password'}
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={onEdit(setConfirmation)}
          onBlur={handleConfirmationBlur}
          disabled={busy}
          className={INPUT_CLASS}
        />
      </div>

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

      <Button
        type="submit"
        variant="secondary"
        size="lg"
        fullWidth
        leftIcon={<KeyRound className="size-4 shrink-0" />}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? 'Saving...' : 'Save password'}
      </Button>
    </form>
  );
}
