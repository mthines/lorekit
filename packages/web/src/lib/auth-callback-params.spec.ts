import { describe, it, expect } from 'vitest';
import {
  classifyAuthCallback,
  fragmentCarriesAuthResult,
  EMAIL_OTP_TYPES,
} from './auth-callback-params';

const q = (search: string) => new URLSearchParams(search);

describe('classifyAuthCallback', () => {
  it('classifies a PKCE code exchange', () => {
    expect(classifyAuthCallback(q('code=abc123'))).toEqual({ kind: 'code', code: 'abc123' });
  });

  it('classifies a token-hash verification for every supported OTP type', () => {
    for (const type of EMAIL_OTP_TYPES) {
      expect(classifyAuthCallback(q(`token_hash=xyz&type=${type}`))).toEqual({
        kind: 'token_hash',
        tokenHash: 'xyz',
        type,
      });
    }
  });

  it('prefers token_hash over code — it does not depend on this browser', () => {
    expect(classifyAuthCallback(q('code=abc&token_hash=xyz&type=signup'))).toEqual({
      kind: 'token_hash',
      tokenHash: 'xyz',
      type: 'signup',
    });
  });

  it('treats an error as terminal even when a code is present', () => {
    expect(
      classifyAuthCallback(q('code=abc&error=access_denied&error_description=Email+link+is+invalid')),
    ).toEqual({
      kind: 'error',
      errorCode: 'access_denied',
      errorDescription: 'Email link is invalid',
    });
  });

  it('prefers the specific error_code over the generic error', () => {
    expect(classifyAuthCallback(q('error=access_denied&error_code=otp_expired'))).toMatchObject({
      kind: 'error',
      errorCode: 'otp_expired',
    });
  });

  it('omits errorDescription when Supabase sent none', () => {
    expect(classifyAuthCallback(q('error_code=otp_expired'))).toEqual({
      kind: 'error',
      errorCode: 'otp_expired',
    });
  });

  it('ignores a token_hash with a missing or unknown type', () => {
    expect(classifyAuthCallback(q('token_hash=xyz'))).toEqual({ kind: 'none' });
    expect(classifyAuthCallback(q('token_hash=xyz&type=bogus'))).toEqual({ kind: 'none' });
  });

  it('falls back to the code when the type is unusable but a code exists', () => {
    expect(classifyAuthCallback(q('token_hash=xyz&type=bogus&code=abc'))).toEqual({
      kind: 'code',
      code: 'abc',
    });
  });

  it('returns none for an empty or unrelated query string', () => {
    expect(classifyAuthCallback(q(''))).toEqual({ kind: 'none' });
    expect(classifyAuthCallback(q('utm_source=newsletter'))).toEqual({ kind: 'none' });
  });
});

describe('fragmentCarriesAuthResult', () => {
  it('detects an implicit-flow session fragment', () => {
    expect(fragmentCarriesAuthResult('#access_token=abc&refresh_token=def&type=signup')).toBe(true);
  });

  it('works with or without the leading hash', () => {
    expect(fragmentCarriesAuthResult('access_token=abc')).toBe(true);
    expect(fragmentCarriesAuthResult('#access_token=abc')).toBe(true);
  });

  it('detects an error delivered in the fragment', () => {
    expect(fragmentCarriesAuthResult('#error=access_denied&error_code=otp_expired')).toBe(true);
  });

  it('is false for an empty, bare, or ordinary fragment', () => {
    expect(fragmentCarriesAuthResult('')).toBe(false);
    expect(fragmentCarriesAuthResult('#')).toBe(false);
    expect(fragmentCarriesAuthResult('#features')).toBe(false);
    expect(fragmentCarriesAuthResult('#section=pricing')).toBe(false);
  });
});
