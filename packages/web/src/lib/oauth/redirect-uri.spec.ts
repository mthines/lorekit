import { describe, it, expect } from 'vitest';
import {
  buildRedirect,
  checkRedirectUri,
  isAllowedRedirectUri,
  redirectUriMatches,
} from './redirect-uri';

describe('checkRedirectUri', () => {
  it('accepts https', () => {
    expect(checkRedirectUri('https://example.com/cb')).toEqual({ ok: true });
  });

  it('accepts http on loopback (RFC 8252 — native clients bind a local port)', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:51703/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:8123/oauth')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]:8123/oauth')).toBe(true);
  });

  it('rejects plaintext http anywhere else — the interception vector', () => {
    expect(checkRedirectUri('http://example.com/cb')).toEqual({
      ok: false,
      reason: 'insecure_scheme',
    });
    // A hostname that merely CONTAINS a loopback label is not loopback.
    expect(isAllowedRedirectUri('http://127.0.0.1.evil.com/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost.evil.com/cb')).toBe(false);
  });

  it('accepts a dotted private-use scheme (RFC 8252 §7.1)', () => {
    expect(isAllowedRedirectUri('com.example.app:/oauth/callback')).toBe(true);
  });

  it('rejects an undotted custom scheme', () => {
    expect(checkRedirectUri('myapp:/cb')).toEqual({ ok: false, reason: 'unsupported_scheme' });
  });

  it('rejects a fragment — the code would be unreachable to the client', () => {
    expect(checkRedirectUri('https://example.com/cb#frag')).toEqual({
      ok: false,
      reason: 'fragment_not_allowed',
    });
    expect(checkRedirectUri('com.example.app:/cb#frag')).toEqual({
      ok: false,
      reason: 'fragment_not_allowed',
    });
  });

  it('rejects userinfo — it renders as one host and resolves as another', () => {
    expect(checkRedirectUri('https://trusted.example.com@evil.com/cb')).toEqual({
      ok: false,
      reason: 'userinfo_not_allowed',
    });
  });

  it('rejects empty, absurdly long, and unparseable input without throwing', () => {
    expect(checkRedirectUri('')).toEqual({ ok: false, reason: 'unparseable' });
    expect(checkRedirectUri(null)).toEqual({ ok: false, reason: 'unparseable' });
    expect(checkRedirectUri('not a url')).toEqual({ ok: false, reason: 'unparseable' });
    expect(checkRedirectUri(`https://example.com/${'a'.repeat(2100)}`)).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });
});

describe('redirectUriMatches', () => {
  it('matches exactly', () => {
    expect(redirectUriMatches('https://a.example/cb', ['https://a.example/cb'])).toBe(true);
    expect(redirectUriMatches('https://a.example/cb', ['https://a.example/other'])).toBe(false);
  });

  it('ignores the PORT for loopback, and nothing else', () => {
    const registered = ['http://127.0.0.1:1234/callback'];
    expect(redirectUriMatches('http://127.0.0.1:51703/callback', registered)).toBe(true);
    // Path still has to match.
    expect(redirectUriMatches('http://127.0.0.1:51703/other', registered)).toBe(false);
    // Host still has to match — localhost and 127.0.0.1 are not interchangeable.
    expect(redirectUriMatches('http://localhost:51703/callback', registered)).toBe(false);
    // Query still has to match.
    expect(redirectUriMatches('http://127.0.0.1:51703/callback?x=1', registered)).toBe(false);
  });

  it('does not extend the port exception to https', () => {
    expect(redirectUriMatches('https://a.example:8443/cb', ['https://a.example:443/cb'])).toBe(false);
  });

  it('refuses a requested URI that is not allowed at all, even if registered', () => {
    // Defence in depth: a client registered before a rule tightened must not
    // keep an escape hatch.
    expect(redirectUriMatches('http://evil.com/cb', ['http://evil.com/cb'])).toBe(false);
  });
});

describe('buildRedirect', () => {
  it('appends to the query string, never the fragment', () => {
    expect(buildRedirect('https://a.example/cb', { code: 'abc', state: 'xyz' })).toBe(
      'https://a.example/cb?code=abc&state=xyz',
    );
  });

  it('preserves an existing query', () => {
    expect(buildRedirect('https://a.example/cb?x=1', { code: 'abc' })).toBe(
      'https://a.example/cb?x=1&code=abc',
    );
  });

  it('omits undefined params so a missing state is absent, not empty', () => {
    expect(buildRedirect('https://a.example/cb', { code: 'abc', state: undefined })).toBe(
      'https://a.example/cb?code=abc',
    );
  });

  it('percent-encodes values', () => {
    expect(buildRedirect('com.example.app:/cb', { state: 'a b&c=d' })).toBe(
      'com.example.app:/cb?state=a%20b%26c%3Dd',
    );
  });
});
