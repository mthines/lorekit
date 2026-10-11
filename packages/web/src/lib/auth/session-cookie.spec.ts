import { describe, it, expect } from 'vitest';
import { SESSION_MAX_AGE_SECONDS, sessionCookieMaxAge } from './session-cookie';

describe('SESSION_MAX_AGE_SECONDS', () => {
  it('keeps a user signed in for 7 days without a session refresh', () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('sessionCookieMaxAge', () => {
  it('applies the session window to a cookie supabase-ssr is setting', () => {
    // supabase-ssr 0.6 sets session cookies with its own 400-day default.
    expect(sessionCookieMaxAge(400 * 24 * 60 * 60)).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('applies the session window when no max-age was requested', () => {
    expect(sessionCookieMaxAge(undefined)).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('passes a deletion (maxAge 0) through so sign-out clears the cookie', () => {
    expect(sessionCookieMaxAge(0)).toBe(0);
  });
});
