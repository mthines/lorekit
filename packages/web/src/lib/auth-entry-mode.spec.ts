import { describe, expect, it } from 'vitest';

import { SIGNUP_PATH, authEntryHref, parseAuthEntryMode } from './auth-entry-mode';

describe('parseAuthEntryMode', () => {
  it('reads signup', () => {
    expect(parseAuthEntryMode('signup')).toBe('signup');
  });

  it('defaults to signin when absent', () => {
    expect(parseAuthEntryMode(undefined)).toBe('signin');
    expect(parseAuthEntryMode(null)).toBe('signin');
  });

  it('treats any other value as signin', () => {
    expect(parseAuthEntryMode('signin')).toBe('signin');
    expect(parseAuthEntryMode('SIGNUP')).toBe('signin');
    expect(parseAuthEntryMode('')).toBe('signin');
  });

  it('reads the first value of a repeated parameter', () => {
    expect(parseAuthEntryMode(['signup', 'signin'])).toBe('signup');
    expect(parseAuthEntryMode([])).toBe('signin');
  });
});

describe('SIGNUP_PATH', () => {
  it('round-trips through the parser', () => {
    const url = new URL(SIGNUP_PATH, 'https://lorekit.io');
    expect(url.pathname).toBe('/login');
    expect(parseAuthEntryMode(url.searchParams.get('mode'))).toBe('signup');
  });
});

describe('authEntryHref', () => {
  it('builds the bare URLs', () => {
    expect(authEntryHref('signin')).toBe('/login');
    expect(authEntryHref('signup')).toBe(SIGNUP_PATH);
  });

  it('carries next through in both directions', () => {
    expect(authEntryHref('signup', '/lore?scope=a')).toBe('/login?mode=signup&next=%2Flore%3Fscope%3Da');
    expect(authEntryHref('signin', ['/settings/api-keys'])).toBe('/login?next=%2Fsettings%2Fapi-keys');
  });

  it('ignores an empty next', () => {
    expect(authEntryHref('signin', '')).toBe('/login');
    expect(authEntryHref('signup', null)).toBe(SIGNUP_PATH);
  });
});
