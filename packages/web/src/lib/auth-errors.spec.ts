import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from './auth-errors';
import { MIN_PASSWORD_LENGTH } from './password-policy';

describe('friendlyAuthError', () => {
  it('maps invalid credentials without leaking whether the account exists', () => {
    const byCode = friendlyAuthError({
      message: 'Invalid login credentials',
      code: 'invalid_credentials',
    });
    expect(byCode).toContain('Incorrect email or password');
    // No enumeration oracle: the message must not claim the account is unknown.
    expect(byCode.toLowerCase()).not.toContain('no account');
    expect(byCode.toLowerCase()).not.toContain('not found');

    // Same outcome when only the message is available (no code).
    expect(friendlyAuthError({ message: 'Invalid login credentials' })).toBe(byCode);
  });

  it('maps an unconfirmed email to the confirm-your-inbox message', () => {
    expect(
      friendlyAuthError({ message: 'Email not confirmed', code: 'email_not_confirmed' }),
    ).toContain('confirm your email');
  });

  it('maps an existing account on sign-up without leaking that it exists', () => {
    const message = friendlyAuthError({
      message: 'User already registered',
      code: 'user_already_exists',
    });
    // No enumeration oracle: the copy must not confirm the address is taken.
    const lowered = message.toLowerCase();
    expect(lowered).not.toContain('already exists');
    expect(lowered).not.toContain('already registered');
    expect(lowered).not.toContain('taken');
    // It must still leave the user a way forward.
    expect(lowered).toContain('sign in or reset your password');
    // Same outcome when only the raw message is available (no code).
    expect(friendlyAuthError({ message: 'User already registered' })).toBe(message);
  });

  it('maps a weak password to the policy minimum', () => {
    expect(friendlyAuthError({ message: 'Password is too weak', code: 'weak_password' })).toBe(
      `That password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    expect(
      friendlyAuthError({ message: 'Password should be at least 8 characters' }),
    ).toContain(`${MIN_PASSWORD_LENGTH} characters`);
  });

  it('maps a reused password on change to a distinct message', () => {
    expect(friendlyAuthError({ message: 'New password should be different from the old password.' }))
      .toContain('must be different');
  });

  it('maps an expired recovery link', () => {
    expect(friendlyAuthError({ message: 'Token has expired', code: 'otp_expired' })).toContain(
      'expired',
    );
  });

  it('maps a missing session', () => {
    expect(friendlyAuthError({ message: 'Auth session missing!' })).toContain('session has expired');
  });

  it('maps rate limiting by message and by HTTP status', () => {
    expect(friendlyAuthError({ message: 'Email rate limit exceeded' })).toContain('Too many');
    expect(friendlyAuthError({ message: 'whatever', status: 429 })).toContain('Too many');
  });

  it('maps an invalid email address', () => {
    expect(friendlyAuthError({ message: 'Unable to validate email address' })).toContain(
      'valid email address',
    );
  });

  it('maps disabled signups', () => {
    expect(friendlyAuthError({ message: 'Signups not allowed for this instance' })).toContain(
      'Sign-up is currently disabled',
    );
  });

  it('maps an SMTP delivery failure', () => {
    expect(friendlyAuthError({ message: 'Error sending confirmation mail: smtp failure' })).toContain(
      "couldn't deliver",
    );
  });

  it('falls back to the capitalised raw message', () => {
    expect(friendlyAuthError({ message: 'something odd happened' })).toBe(
      'Something odd happened',
    );
  });

  it('is a total function for an empty message', () => {
    expect(friendlyAuthError({ message: '' })).toBe('');
  });
});
