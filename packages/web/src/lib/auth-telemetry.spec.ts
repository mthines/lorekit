import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mirrors `lib/analytics/track.spec.ts`'s stand-in: records the wire shape
// `emit()` hands `sendEvent` rather than asserting against the real SDK, which
// never runs in a unit test.
vi.mock('@dash0/sdk-web', () => {
  const calls: Array<{ name: string; attributes: Record<string, string> }> = [];
  return {
    sendEvent: (name: string, options: { attributes: Record<string, string> }) => {
      calls.push({ name, attributes: options.attributes });
    },
    __calls: calls,
  };
});

import {
  authErrorCode,
  authIntent,
  AUTH_PENDING_EVENT,
  reportAuthPending,
  type AuthMethod,
} from './auth-telemetry';

const { __calls: calls } = (await import('@dash0/sdk-web')) as unknown as {
  __calls: Array<{ name: string; attributes: Record<string, string> }>;
};

beforeEach(() => {
  calls.length = 0;
});

describe('authErrorCode', () => {
  it('prefers the stable Supabase error code', () => {
    expect(authErrorCode({ code: 'invalid_credentials', name: 'AuthApiError' })).toBe(
      'invalid_credentials',
    );
  });

  it('falls back to the error name when there is no code', () => {
    expect(authErrorCode({ name: 'AuthRetryableFetchError' })).toBe('AuthRetryableFetchError');
  });

  it('reports unknown rather than throwing on an empty error', () => {
    expect(authErrorCode({})).toBe('unknown');
  });

  // Telemetry must never be the reason an auth handler throws, so the function
  // is total over the nullish inputs a `catch` can realistically hand it.
  it('reports unknown for null and undefined', () => {
    expect(authErrorCode(null)).toBe('unknown');
    expect(authErrorCode(undefined)).toBe('unknown');
  });

  // GoTrue gives a broken mailer no stable `code` — only a message. Without
  // this, a DNS-misconfigured sending domain and every other server-side auth
  // fault reported the same generic `name`, with no way to alert on the
  // mailer specifically.
  it('classifies a broken mailer as email_send_failed even with no stable code', () => {
    expect(
      authErrorCode({ name: 'AuthApiError', message: 'Error sending confirmation email' }),
    ).toBe('email_send_failed');
    expect(
      authErrorCode({
        name: 'AuthApiError',
        message: 'Error sending confirmation email: dial tcp: lookup mail.example.com: no such host',
      }),
    ).toBe('email_send_failed');
  });
});

describe('authIntent', () => {
  it('separates signing in from signing up on the password paths', () => {
    expect(authIntent('email_password')).toBe('login');
    expect(authIntent('email_password_signup')).toBe('signup');
  });

  it('counts email confirmation as part of the signup it completes', () => {
    expect(authIntent('email_confirmation')).toBe('signup');
  });

  // Both register a new visitor and sign in a returning one, and the browser
  // cannot tell which before the provider answers. Reporting either would be a
  // guess; `auth.outcome` settles it server-side instead.
  it('refuses to guess on the create-on-first-use paths', () => {
    expect(authIntent('github_oauth')).toBe('login_or_signup');
    expect(authIntent('email_otp')).toBe('login_or_signup');
  });

  it('keeps recovery and account management out of the acquisition funnel', () => {
    expect(authIntent('password_reset_request')).toBe('recovery');
    expect(authIntent('password_reset_complete')).toBe('recovery');
    expect(authIntent('password_change_settings')).toBe('account_management');
  });

  // The mapping is a total Record, so a new method is a type error rather than
  // a silent `undefined` on every event it emits. This pins that at runtime too.
  it('maps every known method to a defined intent', () => {
    const methods: AuthMethod[] = [
      'github_oauth',
      'email_password',
      'email_password_signup',
      'email_otp',
      'email_confirmation',
      'password_reset_request',
      'password_reset_complete',
      'password_change_settings',
    ];
    for (const method of methods) {
      expect(authIntent(method)).toBeTruthy();
    }
  });
});

describe('reportAuthPending', () => {
  // This is the one event on the "check your inbox" branch — see the
  // docblock at its definition for why neither success nor failure fires
  // there, and why that used to mean nothing did.
  it('emits auth.pending with the method and its intent', () => {
    reportAuthPending('email_password_signup');

    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe(AUTH_PENDING_EVENT);
    expect(calls[0]!.attributes).toEqual({
      'auth.method': 'email_password_signup',
      'auth.intent': 'signup',
    });
  });
});
