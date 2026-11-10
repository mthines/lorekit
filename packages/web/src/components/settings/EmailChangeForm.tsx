'use client';

import { useEffect, useId, useRef, useState } from 'react';
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
  type AuthMethod,
} from '@/lib/auth-telemetry';
import {
  EMAIL_CHANGE_PAGE_PATH,
  EMAIL_CHANGE_RETURN_PATH,
  emailChangeOutcome,
  emailChangeReturnNotice,
  friendlyEmailChangeError,
  validateEmailChange,
  type EmailChangeReturnNotice,
} from '@/lib/email-change';
import { Button } from '@/components/ui/Button';
import { SETTINGS_INPUT_CLASS, SETTINGS_LABEL_CLASS } from './form-styles';

/** What the confirmation link brought back in the URL — see `settings/user/page.tsx`. */
export interface EmailChangeReturn {
  /** The page was reached through a confirmation link (`?email_change=1`). */
  returned: boolean;
  /** The `?error=` code the callback appended, or `null`. Never rendered raw. */
  linkError: string | null;
}

interface EmailChangeFormProps {
  user: User;
  emailChangeReturn: EmailChangeReturn;
}

const AUTH_METHOD: AuthMethod = 'email_change_settings';

const NOTICE_TONE_CLASS: Record<EmailChangeReturnNotice['tone'], string> = {
  error: 'text-red-400',
  info: 'text-[var(--color-content-secondary)]',
  success: 'text-[var(--color-success)]',
};

/**
 * The change-email field in Settings → User.
 *
 * Hands the whole confirmation flow to Supabase Auth (see `lib/email-change.ts`):
 * `updateUser({ email })` stores the address as `user.new_email` and emails the
 * confirmation link(s); each link goes through `/api/auth/callback` and back
 * here with `?email_change=1`. Until every link is opened the account keeps
 * its current address, so the form shows the pending address rather than
 * pretending the change is done.
 */
export function EmailChangeForm({ user, emailChangeReturn }: EmailChangeFormProps) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const noticeId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentEmail = user.email ?? null;
  const [email, setEmail] = useState('');
  // `||`, not `??`: an empty `new_email` means nothing is pending.
  const [pendingEmail, setPendingEmail] = useState<string | null>(user.new_email || null);
  // Captured once, from the URL the confirmation link landed on.
  const [notice, setNotice] = useState(() =>
    emailChangeReturnNotice({
      ...emailChangeReturn,
      pendingEmail: user.new_email || null,
      currentEmail,
    }),
  );
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // Drop `?email_change` / `?error` once read so a reload does not replay the
  // notice. `history.replaceState`, not `router.replace`: the latter re-renders
  // the page without the params, and the notice is already in state.
  useEffect(() => {
    if (!emailChangeReturn.returned && !emailChangeReturn.linkError) return;
    window.history.replaceState(window.history.state, '', `${EMAIL_CHANGE_PAGE_PATH}${window.location.hash}`);
  }, [emailChangeReturn.returned, emailChangeReturn.linkError]);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value);
    if (error) setError('');
    if (success) setSuccess('');
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setNotice(null);

    const result = validateEmailChange(email, currentEmail);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setBusy(true);
    reportAuthAttempt(AUTH_METHOD);
    try {
      const supabase = createClient();
      const { data: updated, error: updateError } = await supabase.auth.updateUser(
        { email: result.value },
        { emailRedirectTo: buildAuthCallbackUrl(authCallbackOrigin(), EMAIL_CHANGE_RETURN_PATH) },
      );

      if (updateError) {
        reportAuthFailure(AUTH_METHOD, updateError);
        setError(friendlyEmailChangeError(updateError));
        return;
      }

      setEmail('');
      const outcome = emailChangeOutcome(updated.user, result.value);
      if (outcome.kind === 'applied') {
        reportAuthSuccess(AUTH_METHOD);
        setPendingEmail(null);
        setSuccess('Email address updated.');
      } else {
        reportAuthPending(AUTH_METHOD);
        setPendingEmail(outcome.pendingEmail);
        setSuccess('Confirmation link sent.');
      }
      router.refresh();
    } catch (err) {
      reportAuthFailure(AUTH_METHOD, err instanceof Error ? err : null);
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      // Disabling the button while sending drops keyboard focus to <body>;
      // put it back on the field so the next Tab starts from here.
      if (!formRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }
  }

  const describedBy = [notice ? noticeId : null, hintId, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex flex-col gap-1.5">
      {notice && (
        <p
          id={noticeId}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mb-1.5 text-xs ${NOTICE_TONE_CLASS[notice.tone]}`}
        >
          {notice.message}
        </p>
      )}

      {pendingEmail && (
        <div className="mb-1.5 flex gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
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
          ref={inputRef}
          id={inputId}
          name="new-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          value={email}
          onChange={handleChange}
          readOnly={busy}
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
      {/* Always mounted, so screen readers announce the text when it appears. */}
      <div role="status" className="text-xs text-[var(--color-success)]">
        {success}
      </div>
    </form>
  );
}
