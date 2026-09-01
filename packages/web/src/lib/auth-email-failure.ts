/**
 * Whether a Supabase auth error is GoTrue failing to SEND the auth email —
 * a broken mailer (bad SMTP credentials, a DNS record the sending domain
 * needs but doesn't have, the relay unreachable) — as opposed to any other
 * kind of `AuthApiError`.
 *
 * GoTrue never gives this failure a stable `code`; every mail failure comes
 * back as a generic `AuthApiError`, and the only thing that names it is the
 * message, always prefixed "Error sending <kind> email" (confirmation, magic
 * link, recovery, invite) followed by whatever the underlying transport
 * reported. That prefix is the one thing this function can rely on staying
 * stable across mail providers and failure shapes — matching on "smtp" alone
 * misses a DNS-resolution failure to the mail relay (`dial tcp: lookup … no
 * such host` never mentions SMTP), which is exactly the failure this exists
 * to catch.
 *
 * Shared by `auth-errors.ts` (user-facing copy) and `auth-telemetry.ts` (the
 * bounded `auth.error_code`) so the two can never classify the same error
 * differently.
 */
export function isEmailSendFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  const msg = message.toLowerCase();
  return (msg.includes('error sending') && msg.includes('email')) || msg.includes('smtp') || msg.includes('delivery');
}
