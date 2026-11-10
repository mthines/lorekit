'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { MailCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { authCallbackOrigin, buildAuthCallbackUrl } from '@/lib/auth-callback-url';
import {
  reportAuthAttempt,
  reportAuthFailure,
  reportAuthPending,
  reportAuthSuccess,
} from '@/lib/auth-telemetry';
import {
  EMAIL_CHANGE_RETURN_PATH,
  friendlyEmailChangeError,
  friendlyEmailChangeLinkError,
  validateEmailChange,
} from '@/lib/email-change';
import { Button } from '@/components/ui/Button';
import { SETTINGS_INPUT_CLASS, SETTINGS_LABEL_CLASS } from './form-styles';

interface EmailChangeFormProps {
  user: User;
  /**
   * The `?error=` code `/api/auth/callback` appended when a confirmation link
   * failed, or `null`. Mapped to fixed copy — never rendered raw.
   */
  linkError: string | null;
}

/**
 * The change-email field in Settings → User.
 *
 * Hands the whole confirmation flow to Supabase Auth (see `lib/email-change.ts`):
 * `updateUser({ email })` stores the address as `user.new_email` and emails the
 * confirmation link(s); opening them goes through `/api/auth/callback` and back
 * here. Until then the account keeps its current address, so the form shows
 * the pending address rather than pretending the change is done.
 *
 * A project that auto-confirms email changes applies the address immediately;
 * that is detected from the returned user and reported as done.
 */
export function EmailChangeForm({ user, linkError }: EmailChangeFormProps) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const currentEmail = user.email ?? null;
  const [email, setEmail] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(
    // `||`, not `??`: an empty string means no change is pending.
    user.new_email || null,
  );
  const [showLinkError, setShowLinkError] = useState(!!linkError);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value);
    if (error) setError('');
    if (success) setSuccess('');
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setShowLinkError(false);

    const result = validateEmailChange(email, currentEmail);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setBusy(true);
    reportAuthAttempt('email_change_settings');
    const supabase = createClient();
    const { data, error: updateError } = await supabase.auth.updateUser(
      { email: result.value },
      { emailRedirectTo: buildAuthCallbackUrl(authCallbackOrigin(), EMAIL_CHANGE_RETURN_PATH) },
    );
    setBusy(false);

    if (updateError) {
      reportAuthFailure('email_change_settings', updateError);
      setError(friendlyEmailChangeError(updateError));
      return;
    }

    setEmail('');
    if (data.user?.email && data.user.email.toLowerCase() === result.value.toLowerCase()) {
      reportAuthSuccess('email_change_settings');
      setPendingEmail(null);
      setSuccess('Email address updated.');
    } else {
      reportAuthPending('email_change_settings');
      setPendingEmail(data.user?.new_email || result.value);
    }
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      {showLinkError && linkError && (
        <p role="alert" className="mb-1.5 text-xs text-red-400">
          {friendlyEmailChangeLinkError(linkError)}
        </p>
      )}

      {pendingEmail && (
        <div
          role="status"
          className="mb-1.5 flex gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
        >
          <MailCheck
            className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]"
            aria-hidden
          />
          <div className="min-w-0 text-xs text-[var(--color-content-secondary)]">
            <p>
              Waiting for you to confirm{' '}
              <span className="break-all font-medium text-[var(--color-content-primary)]">
                {pendingEmail}
              </span>
              . Open the link we sent there
              {currentEmail ? ' — and the one sent to your current address, if you got one' : ''}.
            </p>
            <p className="mt-1">
              Until then you keep using your current address. No email? Request the change again
              below.
            </p>
          </div>
        </div>
      )}

      <label htmlFor={inputId} className={SETTINGS_LABEL_CLASS}>
        New email address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          name="new-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          value={email}
          onChange={handleChange}
          disabled={busy}
          className={`${SETTINGS_INPUT_CLASS} sm:flex-1`}
        />
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="sm:min-h-11"
          disabled={busy || !email.trim()}
          isLoading={busy}
          analyticsId="settings.email-change-request"
        >
          {busy ? 'Sending...' : 'Change email'}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-[var(--color-content-tertiary)]">
        We email a confirmation link first; the address only changes once you open it. Use the new
        address for email sign-in afterwards — GitHub sign-in keeps working.
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-xs text-[var(--color-success)]">
          {success}
        </p>
      )}
    </form>
  );
}
