import { describe, it, expect } from 'vitest';
import { expandOriginSiblings, expandAllowedOrigins, isOriginAllowed } from './cors-origins.ts';

// Regression guard for the CORS www/apex mismatch that broke the dashboard after
// it moved off PostgREST onto the REST edge functions: the app is served from the
// canonical https://www.lorekit.io, but `ALLOWED_ORIGINS` named only the apex
// https://lorekit.io, so the preflight from the www host was blocked.

describe('expandOriginSiblings', () => {
  it('expands an apex origin to both apex and www', () => {
    expect(expandOriginSiblings('https://lorekit.io')).toEqual([
      'https://lorekit.io',
      'https://www.lorekit.io',
    ]);
  });

  it('expands a www origin to both apex and www', () => {
    expect(expandOriginSiblings('https://www.lorekit.io')).toEqual([
      'https://lorekit.io',
      'https://www.lorekit.io',
    ]);
  });

  it('preserves scheme and port when deriving the sibling', () => {
    expect(expandOriginSiblings('http://localhost:3000')).toEqual([
      'http://localhost:3000',
      'http://www.localhost:3000',
    ]);
  });

  it('passes the wildcard through unchanged', () => {
    expect(expandOriginSiblings('*')).toEqual(['*']);
  });

  it('keeps an unparseable origin verbatim rather than throwing', () => {
    expect(expandOriginSiblings('not a url')).toEqual(['not a url']);
  });
});

describe('expandAllowedOrigins', () => {
  it('deduplicates when apex and www are both configured', () => {
    expect(expandAllowedOrigins(['https://lorekit.io', 'https://www.lorekit.io'])).toEqual([
      'https://lorekit.io',
      'https://www.lorekit.io',
    ]);
  });

  it('expands every configured origin', () => {
    expect(expandAllowedOrigins(['https://a.com', 'https://b.com'])).toEqual([
      'https://a.com',
      'https://www.a.com',
      'https://b.com',
      'https://www.b.com',
    ]);
  });
});

describe('isOriginAllowed', () => {
  it('admits the www host when the allowlist names only the apex (the regression)', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    expect(isOriginAllowed(allowed, 'https://www.lorekit.io')).toBe(true);
    expect(isOriginAllowed(allowed, 'https://lorekit.io')).toBe(true);
  });

  it('admits the apex host when the allowlist names only www', () => {
    const allowed = expandAllowedOrigins(['https://www.lorekit.io']);
    expect(isOriginAllowed(allowed, 'https://lorekit.io')).toBe(true);
    expect(isOriginAllowed(allowed, 'https://www.lorekit.io')).toBe(true);
  });

  it('rejects an unrelated origin', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    expect(isOriginAllowed(allowed, 'https://evil.com')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://www.evil.com')).toBe(false);
  });

  it('does not treat a lookalike suffix as a sibling', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    expect(isOriginAllowed(allowed, 'https://notlorekit.io')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://lorekit.io.evil.com')).toBe(false);
  });

  it('allows any origin when the wildcard is configured', () => {
    const allowed = expandAllowedOrigins(['*']);
    expect(isOriginAllowed(allowed, 'https://anything.com')).toBe(true);
  });

  it('rejects an empty origin unless the wildcard is set', () => {
    expect(isOriginAllowed(expandAllowedOrigins(['https://lorekit.io']), '')).toBe(false);
    expect(isOriginAllowed(expandAllowedOrigins(['*']), '')).toBe(true);
  });
});
