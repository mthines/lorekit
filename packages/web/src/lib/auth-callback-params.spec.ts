import { describe, it, expect } from 'vitest';
import {
  classifyAuthCallback,
  fragmentCarriesAuthResult,
  isGithubAppSetupReturn,
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

  // Regression: the GitHub App Setup-URL return carries GitHub's own OAuth
  // `code`. Classifying it as PKCE sent it to `exchangeCodeForSession`, which
  // failed with `pkce_code_verifier_not_found` and redirected the user to
  // `/dashboard?error=…` instead of associating their installation.
  it('does not classify a GitHub App Setup-URL code as a Supabase PKCE code', () => {
    expect(
      classifyAuthCallback(
        q('code=ddecac6946df5f3899f9&installation_id=150410512&setup_action=install'),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('still exchanges a code when only a stray installation_id is present', () => {
    expect(classifyAuthCallback(q('code=abc&installation_id=150410512'))).toEqual({
      kind: 'code',
      code: 'abc',
    });
  });

  it('still exchanges a code when only a stray setup_action is present', () => {
    expect(classifyAuthCallback(q('code=abc&setup_action=install'))).toEqual({
      kind: 'code',
      code: 'abc',
    });
  });

  it('keeps an explicit provider error terminal on a setup return', () => {
    expect(
      classifyAuthCallback(
        q('error=access_denied&installation_id=150410512&setup_action=install'),
      ),
    ).toMatchObject({ kind: 'error', errorCode: 'access_denied' });
  });
});

describe('isGithubAppSetupReturn', () => {
  it('is true only when both Setup-URL params are present', () => {
    expect(isGithubAppSetupReturn(q('installation_id=1&setup_action=install'))).toBe(true);
    expect(isGithubAppSetupReturn(q('installation_id=1&setup_action=update'))).toBe(true);
  });

  it('is false when either param is missing or empty', () => {
    expect(isGithubAppSetupReturn(q('installation_id=1'))).toBe(false);
    expect(isGithubAppSetupReturn(q('setup_action=install'))).toBe(false);
    expect(isGithubAppSetupReturn(q('installation_id=&setup_action=install'))).toBe(false);
    expect(isGithubAppSetupReturn(q('installation_id=1&setup_action='))).toBe(false);
    expect(isGithubAppSetupReturn(q(''))).toBe(false);
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
