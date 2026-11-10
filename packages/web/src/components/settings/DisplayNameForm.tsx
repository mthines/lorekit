'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import {
  DISPLAY_NAME_METADATA_KEY,
  editableDisplayName,
  validateDisplayName,
} from '@/lib/display-name';
import { Button } from '@/components/ui/Button';
import { SETTINGS_INPUT_CLASS, SETTINGS_LABEL_CLASS } from './form-styles';

interface DisplayNameFormProps {
  user: User;
}

/**
 * The name field in Settings → User.
 *
 * Writes `user_metadata.display_name` through `supabase.auth.updateUser`, never
 * `full_name` — GitHub sign-in rewrites `full_name` every time, see
 * `lib/display-name.ts`. An empty field deletes the key, which falls the shown
 * name back to the GitHub name or the email address.
 *
 * `router.refresh()` after a save re-renders the server layout, whose
 * `getVerifiedUser()` reads the user fresh from Supabase Auth — that is what
 * updates the Sidebar's name without a reload.
 */
export function DisplayNameForm({ user }: DisplayNameFormProps) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();

  // What is stored now, to tell an edit from an untouched field.
  const [saved, setSaved] = useState(() => editableDisplayName(user));
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
    const supabase = createClient();
    const { data, error: updateError } = await supabase.auth.updateUser({
      data: { [DISPLAY_NAME_METADATA_KEY]: result.value },
    });
    setBusy(false);

    if (updateError) {
      setError(friendlyAuthError(updateError));
      return;
    }

    // Read the stored value back rather than echoing the input: clearing the
    // field falls back to `full_name`, and the field should show that.
    const stored = data.user ? editableDisplayName(data.user) : (result.value ?? '');
    setSaved(stored);
    setName(stored);
    setSuccess(result.value ? 'Name saved.' : 'Name cleared. Your default name is shown instead.');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className={SETTINGS_LABEL_CLASS}>
        Display name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          name="display-name"
          type="text"
          autoComplete="name"
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          value={name}
          onChange={handleChange}
          disabled={busy}
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
        <p role="alert" className="text-xs text-red-400">
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
