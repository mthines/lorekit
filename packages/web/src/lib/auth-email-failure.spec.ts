import { describe, expect, it } from 'vitest';

import { isEmailSendFailure } from './auth-email-failure';

describe('isEmailSendFailure', () => {
  it('matches the stable GoTrue mailer-failure prefix', () => {
    expect(isEmailSendFailure('Error sending confirmation email')).toBe(true);
    expect(isEmailSendFailure('Error sending magic link email')).toBe(true);
    expect(isEmailSendFailure('Error sending recovery email')).toBe(true);
  });

  // The failure that motivated this: a DNS resolution error connecting to the
  // mail relay never mentions "smtp" in its text, so matching that substring
  // alone would have missed it.
  it('matches a DNS-resolution failure that never mentions smtp', () => {
    expect(
      isEmailSendFailure('Error sending confirmation email: dial tcp: lookup mail.example.com: no such host'),
    ).toBe(true);
  });

  it('still matches the legacy smtp/delivery substrings', () => {
    expect(isEmailSendFailure('Error sending confirmation mail: smtp failure')).toBe(true);
    expect(isEmailSendFailure('Mail delivery failed')).toBe(true);
  });

  it('does not match unrelated auth errors', () => {
    expect(isEmailSendFailure('Invalid login credentials')).toBe(false);
    expect(isEmailSendFailure('Email rate limit exceeded')).toBe(false);
  });

  it('is total for nullish input', () => {
    expect(isEmailSendFailure(null)).toBe(false);
    expect(isEmailSendFailure(undefined)).toBe(false);
    expect(isEmailSendFailure('')).toBe(false);
  });
});
