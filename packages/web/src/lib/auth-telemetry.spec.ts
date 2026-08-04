import { describe, expect, it } from 'vitest';

import { authErrorCode } from './auth-telemetry';

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
});
