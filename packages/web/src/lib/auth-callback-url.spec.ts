import { describe, it, expect } from 'vitest';
import { buildAuthCallbackUrl } from './auth-callback-url';

describe('buildAuthCallbackUrl', () => {
  it('builds the callback URL for an origin without a next param', () => {
    expect(buildAuthCallbackUrl('https://lorekit.io')).toBe(
      'https://lorekit.io/api/auth/callback',
    );
  });

  it('works for a local dev origin on a non-default port', () => {
    expect(buildAuthCallbackUrl('http://localhost:3001')).toBe(
      'http://localhost:3001/api/auth/callback',
    );
  });

  it('threads a safe next path through as a query param', () => {
    expect(buildAuthCallbackUrl('https://lorekit.io', '/lore?lesson=abc')).toBe(
      'https://lorekit.io/api/auth/callback?next=%2Flore%3Flesson%3Dabc',
    );
  });

  it('sanitises an unsafe next path instead of forwarding it', () => {
    expect(buildAuthCallbackUrl('https://lorekit.io', '//evil.com')).toBe(
      'https://lorekit.io/api/auth/callback?next=%2Fdashboard',
    );
  });

  it('omits the next param entirely for null / empty input', () => {
    expect(buildAuthCallbackUrl('https://lorekit.io', null)).toBe(
      'https://lorekit.io/api/auth/callback',
    );
    expect(buildAuthCallbackUrl('https://lorekit.io', '')).toBe(
      'https://lorekit.io/api/auth/callback',
    );
  });

  it('replaces any path on the base origin rather than appending to it', () => {
    expect(buildAuthCallbackUrl('https://lorekit.io/login')).toBe(
      'https://lorekit.io/api/auth/callback',
    );
  });
});
