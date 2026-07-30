/**
 * Pure client-side password policy for the dashboard's email + password auth.
 *
 * This is a *pre-flight* check only — the authoritative policy is the Supabase
 * project's own `minimum_password_length` / `password_requirements` setting
 * (mirrored locally in `supabase/config.toml`). Validating here just turns a
 * round-trip rejection into an instant, specific message.
 *
 * Keep `MIN_PASSWORD_LENGTH` >= the project setting: being stricter in the UI
 * is safe (the server accepts everything the UI does), being laxer is not.
 * That is why this PR leaves `supabase/config.toml` at the Supabase default of
 * 6 — 8 >= 6 holds, so nothing here is unsafe, and raising the backend floor is
 * a backend change that belongs with the hosted projects' dashboard setting
 * rather than with the sign-in UI.
 */

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a password a user is about to set (sign-up, reset, or change).
 *
 * Returns a user-facing error message, or `null` when the password is
 * acceptable. Total function — never throws.
 */
export function validatePassword(password: string): string | null {
  if (!password) return 'Please enter a password.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // A password made only of whitespace is technically long enough but is
  // almost always a paste accident.
  if (!password.trim()) return 'Password cannot be only spaces.';
  return null;
}

/**
 * Validate a new password against its confirmation field.
 *
 * Runs `validatePassword` first so the more specific policy message wins over
 * a generic mismatch. Returns `null` when the pair is acceptable.
 */
export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | null {
  const policyError = validatePassword(password);
  if (policyError) return policyError;
  if (password !== confirmation) return 'The two passwords do not match.';
  return null;
}
