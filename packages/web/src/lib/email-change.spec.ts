import { describe, it, expect } from 'vitest';
import {
  EMAIL_CHANGE_RETURN_PATH,
  emailChangeOutcome,
  emailChangeReturnNotice,
  friendlyEmailChangeError,
  friendlyEmailChangeLinkError,
  validateEmailChange,
} from './email-change';
import { safeNextPath } from './auth-redirect';

describe('EMAIL_CHANGE_RETURN_PATH', () => {
  it('survives the callback’s same-origin check unchanged, query flag included', () => {
    expect(safeNextPath(EMAIL_CHANGE_RETURN_PATH)).toBe(EMAIL_CHANGE_RETURN_PATH);
    expect(EMAIL_CHANGE_RETURN_PATH).toBe('/settings/user?email_change=1');
  });
});

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

describe('emailChangeOutcome', () => {
  it('is pending while the new address waits in new_email', () => {
    expect(emailChangeOutcome({ email: 'old@example.com', new_email: 'new@example.com' }, 'new@example.com')).toEqual(
      { kind: 'pending', pendingEmail: 'new@example.com' },
    );
  });

  it('falls back to the requested address when new_email is empty or absent', () => {
    expect(emailChangeOutcome({ email: 'old@example.com', new_email: '' }, 'new@example.com')).toEqual({
      kind: 'pending',
      pendingEmail: 'new@example.com',
    });
    expect(emailChangeOutcome(null, 'new@example.com')).toEqual({
      kind: 'pending',
      pendingEmail: 'new@example.com',
    });
  });

  it('is applied when the returned user already carries the new address', () => {
    expect(emailChangeOutcome({ email: 'new@example.com' }, 'New@Example.com')).toEqual({ kind: 'applied' });
  });
});

describe('friendlyEmailChangeError', () => {
  it('says plainly when the address belongs to another account', () => {
    const byCode = friendlyEmailChangeError({
      message: 'A user with this email address has already been registered',
      code: 'email_exists',
      status: 422,
    });
    expect(byCode).toContain('already used by another LoreKit account');
    // Not the sign-up copy, which would send the user to an inbox that never gets an email.
    expect(byCode.toLowerCase()).not.toContain('check your inbox');
    expect(friendlyEmailChangeError({ message: 'User already registered', code: 'user_already_exists' })).toBe(
      byCode,
    );
  });

  it('talks about email changes, not sign-in attempts, when the email send limit is hit', () => {
    const message = friendlyEmailChangeError({
      message: 'email rate limit exceeded',
      code: 'over_email_send_rate_limit',
      status: 429,
    });
    expect(message).toContain('email change requests');
    expect(message.toLowerCase()).not.toContain('sign-in');
  });

  it('asks the user to sign in again when the session is gone', () => {
    expect(friendlyEmailChangeError({ message: 'Session not found', code: 'session_not_found' })).toContain(
      'Sign in again',
    );
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
  it('maps a link Supabase rejected to a request-again message', () => {
    expect(friendlyEmailChangeLinkError('otp_expired')).toContain('expired or was already used');
    expect(friendlyEmailChangeLinkError('access_denied')).toContain('expired or was already used');
    expect(friendlyEmailChangeLinkError('OTP_EXPIRED')).toContain('expired or was already used');
  });

  it('never claims a failed code exchange undid the change — Supabase verifies before the exchange', () => {
    for (const code of [
      'flow_state_expired',
      'flow_state_not_found',
      'pkce_code_verifier_not_found',
      'bad_code_verifier',
      'auth_failed',
    ]) {
      const message = friendlyEmailChangeLinkError(code);
      expect(message).toContain('may already have gone through');
      expect(message.toLowerCase()).not.toContain("didn't work");
    }
  });

  it('never echoes an unknown code back into the page', () => {
    expect(friendlyEmailChangeLinkError('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('emailChangeReturnNotice', () => {
  const base = { returned: true, linkError: null, pendingEmail: null, currentEmail: 'new@example.com' };

  it('shows nothing on a plain visit, even with a stray ?error', () => {
    expect(emailChangeReturnNotice({ ...base, returned: false, linkError: 'otp_expired' })).toBeNull();
  });

  it('reports a failed link as an error', () => {
    expect(emailChangeReturnNotice({ ...base, linkError: 'otp_expired' })?.tone).toBe('error');
  });

  it('asks for the other link while the change is still pending', () => {
    const notice = emailChangeReturnNotice({ ...base, pendingEmail: 'new@example.com', currentEmail: 'old@example.com' });
    expect(notice?.tone).toBe('info');
    expect(notice?.message).toContain('other address');
  });

  it('confirms the new address once nothing is pending', () => {
    expect(emailChangeReturnNotice(base)).toEqual({
      tone: 'success',
      message: 'Your email address is now new@example.com.',
    });
  });
});
