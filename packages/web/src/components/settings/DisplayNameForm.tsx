'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { friendlySettingsUpdateError } from '@/lib/auth-errors';
import { authErrorCode } from '@/lib/auth-telemetry';
import { track } from '@/lib/analytics/track';
import {
  DISPLAY_NAME_METADATA_KEY,
  chosenDisplayName,
  fallbackDisplayName,
  validateDisplayName,
} from '@/lib/display-name';
import { Button } from '@/components/ui/Button';
import { SETTINGS_INPUT_CLASS, SETTINGS_LABEL_CLASS } from './form-styles';

const SAVED_EVENT = 'settings.display_name_saved';

interface DisplayNameFormProps {
  user: User;
}

/**
 * The name field in Settings → User.
 *
 * Writes `user_metadata.display_name` through `supabase.auth.updateUser`, never
 * `full_name` — GitHub sign-in rewrites `full_name` every time, see
 * `lib/display-name.ts`. The field holds only the name the user chose; the
 * fallback (GitHub name or email) is its placeholder, so an empty field
 * visibly means "use the default". Saving it empty deletes the key.
 *
 * `router.refresh()` after a save re-renders the server layout, whose
 * `getVerifiedUser()` reads the user fresh from Supabase Auth — that is what
 * updates the Sidebar's name without a reload.
 */
export function DisplayNameForm({ user }: DisplayNameFormProps) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // What is stored now, to tell an edit from an untouched field.
  const [saved, setSaved] = useState(() => chosenDisplayName(user));
  const [name, setName] = useState(saved);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const unchanged = name.trim() === saved;

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    setName(event.target.value);
    if (error) setError('');
    if (success) setSuccess('');
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');

    const result = validateDisplayName(name);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { data: updated, error: updateError } = await supabase.auth.updateUser({
        data: { [DISPLAY_NAME_METADATA_KEY]: result.value },
      });

      if (updateError) {
        track({
          name: SAVED_EVENT,
          outcome: 'error',
          cleared: result.value === null,
          errorCode: authErrorCode(updateError),
        });
        setError(friendlySettingsUpdateError(updateError));
        return;
      }

      track({ name: SAVED_EVENT, outcome: 'success', cleared: result.value === null });

      const stored = updated.user ? chosenDisplayName(updated.user) : (result.value ?? '');
      setSaved(stored);
      setName(stored);
      setSuccess(
        stored ? 'Name saved.' : 'Name cleared. Your GitHub name or email address is shown instead.',
      );
      router.refresh();
    } catch (err) {
      track({
        name: SAVED_EVENT,
        outcome: 'error',
        cleared: result.value === null,
        errorCode: authErrorCode(err instanceof Error ? err : null),
      });
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      // Disabling the button while saving drops keyboard focus to <body>;
      // put it back on the field so the next Tab starts from here.
      if (!formRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className={SETTINGS_LABEL_CLASS}>
        Display name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          id={inputId}
          name="display-name"
          type="text"
          autoComplete="name"
          placeholder={fallbackDisplayName(user)}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          value={name}
          onChange={handleChange}
          readOnly={busy}
          className={`${SETTINGS_INPUT_CLASS} sm:flex-1`}
        />
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="sm:min-h-11"
          disabled={busy || unchanged}
          isLoading={busy}
          analyticsId="settings.display-name-save"
        >
          {busy ? 'Saving...' : 'Save name'}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-[var(--color-content-tertiary)]">
        Shown in the sidebar and the audit log. Leave it empty to use your GitHub name or email
        address.
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
