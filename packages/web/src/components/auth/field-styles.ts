/**
 * Shared Tailwind class strings for the auth surfaces.
 *
 * `LoginButton`, `ForgotPasswordForm` and `UpdatePasswordForm` render the same
 * text/email/password input, so the class string lives here once rather than
 * being copied per file — a single drifted `var(--color-*)` token between
 * copies is not realistically caught by eye.
 *
 * Settings → `PasswordPanel` deliberately does NOT use this: it renders inside
 * a settings card (`rounded-lg`), not on the standalone auth pages
 * (`rounded-xl`).
 */
export const FIELD_CLASS =
  'h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50';
