import { describe, it, expect } from 'vitest';
import {
  expandOriginSiblings,
  expandAllowedOrigins,
  isOriginAllowed,
  corsResponseHeaders,
} from './cors-origins.ts';

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

  it('always admits loopback dev origins even when not in the allowlist', () => {
    // A locally-run dashboard (http://localhost:3000) pointed at the deployed
    // edge functions must not be CORS-blocked.
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    expect(isOriginAllowed(allowed, 'http://localhost:3000')).toBe(true);
    expect(isOriginAllowed(allowed, 'http://localhost:5173')).toBe(true);
    expect(isOriginAllowed(allowed, 'https://localhost')).toBe(true);
    expect(isOriginAllowed(allowed, 'http://127.0.0.1:3000')).toBe(true);
    expect(isOriginAllowed(allowed, 'http://[::1]:3000')).toBe(true);
  });

  it('does not treat a loopback lookalike host as loopback', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    expect(isOriginAllowed(allowed, 'http://localhost.evil.com')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://notlocalhost')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://127.0.0.1.evil.com')).toBe(false);
  });
});

// `corsHeaders(req)` in the Deno-only `_shared/api/cors.ts` is now nothing but
// the `ALLOWED_ORIGINS` read plus a call into `corsResponseHeaders`, so these
// cover the two rules that used to be inline and untestable: the suppress-the-
// header-when-disallowed rule and the `origin || '*'` fallback.
describe('corsResponseHeaders', () => {
  const ALLOWLIST = expandAllowedOrigins(['https://lorekit.io']);
  const WILDCARD = expandAllowedOrigins(['*']);

  it('always emits the origin-independent headers', () => {
    for (const headers of [
      corsResponseHeaders(ALLOWLIST, 'https://lorekit.io'),
      corsResponseHeaders(ALLOWLIST, 'https://evil.com'),
    ]) {
      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, DELETE, OPTIONS');
      expect(headers['Access-Control-Allow-Headers']).toBe(
        'Authorization, Content-Type, traceparent, tracestate, X-LoreKit-Dry-Run',
      );
      // Without this a browser cannot read the server span's traceparent, which
      // is what links client-side RUM to the server trace.
      expect(headers['Access-Control-Expose-Headers']).toBe('traceparent, X-LoreKit-Dry-Run');
      expect(headers['Access-Control-Max-Age']).toBe('86400');
    }
  });

  it('echoes an allowed origin back verbatim', () => {
    expect(corsResponseHeaders(ALLOWLIST, 'https://lorekit.io')['Access-Control-Allow-Origin']).toBe(
      'https://lorekit.io',
    );
    // The www/apex sibling the allowlist never named explicitly — the regression.
    expect(
      corsResponseHeaders(ALLOWLIST, 'https://www.lorekit.io')['Access-Control-Allow-Origin'],
    ).toBe('https://www.lorekit.io');
  });

  it('omits Access-Control-Allow-Origin entirely for a disallowed origin', () => {
    const headers = corsResponseHeaders(ALLOWLIST, 'https://evil.com');
    // Absent, not empty: an empty header value is invalid and surfaces to the
    // browser as a malformed response rather than a clean CORS rejection.
    expect('Access-Control-Allow-Origin' in headers).toBe(false);
  });

  it('omits Access-Control-Allow-Origin for a request that sends no Origin', () => {
    expect('Access-Control-Allow-Origin' in corsResponseHeaders(ALLOWLIST, '')).toBe(false);
  });

  it('falls back to `*` for a request with no Origin when the allowlist is a wildcard', () => {
    expect(corsResponseHeaders(WILDCARD, '')['Access-Control-Allow-Origin']).toBe('*');
  });

  it('echoes the concrete origin, not `*`, when the allowlist is a wildcard', () => {
    expect(corsResponseHeaders(WILDCARD, 'https://anything.com')['Access-Control-Allow-Origin']).toBe(
      'https://anything.com',
    );
  });

  it('returns a fresh object per call so a caller cannot mutate the shared statics', () => {
    const first = corsResponseHeaders(ALLOWLIST, 'https://lorekit.io');
    first['Access-Control-Max-Age'] = '0';
    expect(corsResponseHeaders(ALLOWLIST, 'https://lorekit.io')['Access-Control-Max-Age']).toBe(
      '86400',
    );
  });
});
