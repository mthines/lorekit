/**
 * Pure model for the name the dashboard shows for the signed-in user.
 *
 * ## Why a dedicated `display_name` key
 *
 * The name a user types in Settings → User is stored in Supabase Auth's
 * `user_metadata.display_name`, NOT in `full_name`. Supabase Auth (GoTrue)
 * merges the OAuth provider's identity data into `user_metadata` on EVERY
 * provider sign-in, and GitHub's identity data carries `full_name` and `name`
 * — so a name saved into `full_name` would be silently replaced by the GitHub
 * profile name the next time the user signs in with GitHub. GitHub never sends
 * a `display_name` key, so a value stored there survives every sign-in.
 *
 * `full_name` stays the fallback, so nobody's shown name changes until they
 * choose one, and clearing the field (which deletes the key — GoTrue removes a
 * metadata key whose new value is `null`) returns to it.
 *
 * Import-free on purpose: the Sidebar, the settings panel, and the audit-log
 * actor resolver (`audit-actor.ts`) all read the name through here, so the
 * three can never disagree about which key wins.
 */

/** The `user_metadata` key the user's chosen name is written to. */
export const DISPLAY_NAME_METADATA_KEY = 'display_name';

/**
 * Upper bound for a chosen name, in characters (code points, so an emoji or an
 * accented letter counts once). Generous enough for any real name; the limit
 * exists so the sidebar and the audit log never have to lay out a paragraph.
 */
export const DISPLAY_NAME_MAX_LENGTH = 100;

/** Structural subset of `@supabase/supabase-js`'s `User` this module reads. */
export interface DisplayNameUser {
  email?: string | undefined;
  user_metadata?: Record<string, unknown> | undefined;
}

/** First candidate that is a string with something other than whitespace in it, trimmed. */
export function firstNonBlank(...candidates: Array<unknown>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * The name shown when the user has not chosen one: the provider's
 * `full_name`, else their email address, else the literal `'User'`. The name
 * field uses it as its placeholder, so an empty field visibly means "this".
 */
export function fallbackDisplayName(user: DisplayNameUser): string {
  return firstNonBlank(user.user_metadata?.['full_name'], user.email) ?? 'User';
}

/**
 * The name the user chose in Settings → User, trimmed, or `''` when they have
 * not chosen one. This — not the fallback — is what the name field holds, so
 * clearing and saving leaves it visibly empty instead of refilling it.
 */
export function chosenDisplayName(user: DisplayNameUser): string {
  return firstNonBlank(user.user_metadata?.[DISPLAY_NAME_METADATA_KEY]) ?? '';
}

/**
 * The name to show for `user`: their chosen name, else
 * {@link fallbackDisplayName}. Total — every input yields a non-empty string.
 */
export function resolveDisplayName(user: DisplayNameUser): string {
  return chosenDisplayName(user) || fallbackDisplayName(user);
}

export type DisplayNameValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// Line breaks, tabs, and the other C0/C1 control characters: never part of a
// name, and a stray one would break the single-line layouts that show it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Validate what the user typed into the name field.
 *
 * Returns the trimmed value to save, or `value: null` for an empty field —
 * which means "remove my chosen name and fall back to the default" rather than
 * an error. Total — never throws.
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (CONTROL_CHARACTERS.test(value)) {
    return { ok: false, error: "Your name can't contain line breaks or tabs." };
  }
  if ([...value].length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep your name to ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value };
}
