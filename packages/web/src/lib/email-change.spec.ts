import { describe, it, expect } from 'vitest';
import {
  friendlyEmailChangeError,
  friendlyEmailChangeLinkError,
  validateEmailChange,
} from './email-change';

describe('validateEmailChange', () => {
  it('returns the trimmed address', () => {
    expect(validateEmailChange('  new@example.com ', 'old@example.com')).toEqual({
      ok: true,
      value: 'new@example.com',
    });
  });

  it('rejects an empty field', () => {
    expect(validateEmailChange('   ', 'old@example.com').ok).toBe(false);
  });

  it('rejects something that is not shaped like an address', () => {
    for (const raw of ['new', 'new@', '@example.com', 'new@example', 'new @example.com']) {
      expect(validateEmailChange(raw, 'old@example.com').ok).toBe(false);
    }
  });

  it('rejects the current address, ignoring case', () => {
    const result = validateEmailChange('Old@Example.com', 'old@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already your email');
  });

  it('works for an account with no current address', () => {
    expect(validateEmailChange('new@example.com', null)).toEqual({ ok: true, value: 'new@example.com' });
  });
});

describe('friendlyEmailChangeError', () => {
  it('says plainly when the address belongs to another account', () => {
    const message = friendlyEmailChangeError({
      message: 'A user with this email address has already been registered',
      code: 'email_exists',
      status: 422,
    });
    expect(message).toContain('already used by another LoreKit account');
    // Not the sign-up copy, which would send the user to an inbox that never gets an email.
    expect(message.toLowerCase()).not.toContain('check your inbox');
  });

  it('talks about email changes, not sign-in attempts, when rate limited', () => {
    const message = friendlyEmailChangeError({
      message: 'email rate limit exceeded',
      code: 'over_email_send_rate_limit',
      status: 429,
    });
    expect(message).toContain('email change requests');
    expect(message.toLowerCase()).not.toContain('sign-in');
  });

  it('asks the user to sign in again when the session is gone', () => {
    expect(friendlyEmailChangeError({ message: 'Auth session missing!' })).toContain('Sign in again');
  });

  it('rejects addresses Supabase refuses to send to', () => {
    expect(
      friendlyEmailChangeError({ message: 'Email address "x@test" is invalid', code: 'email_address_invalid' }),
    ).toContain("can't be used");
  });

  it('falls back to the shared auth-error copy for anything else', () => {
    expect(friendlyEmailChangeError({ message: 'something unexpected' })).toBe('Something unexpected');
  });
});

describe('friendlyEmailChangeLinkError', () => {
  it('explains a link opened in another browser without claiming the change failed', () => {
    const message = friendlyEmailChangeLinkError('pkce_code_verifier_not_found');
    expect(message).toContain('different browser');
    expect(message).toContain('may still have gone through');
    expect(friendlyEmailChangeLinkError('flow_state_not_found')).toBe(message);
  });

  it('maps expired or reused links to a request-again message', () => {
    expect(friendlyEmailChangeLinkError('otp_expired')).toContain('expired');
    expect(friendlyEmailChangeLinkError('access_denied')).toContain('expired');
  });

  it('never echoes an unknown code back into the page', () => {
    const message = friendlyEmailChangeLinkError('<script>alert(1)</script>');
    expect(message).not.toContain('<script>');
    expect(message).toContain("didn't work");
  });
});
