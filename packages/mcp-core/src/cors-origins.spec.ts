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

  // The dashboard's Vercel preview deployments get a per-branch/per-commit hostname
  // that can never be listed in ALLOWED_ORIGINS, so they were CORS-blocked once the
  // app moved off PostgREST onto the REST edge functions. They are always admitted.
  it('always admits the project’s own Vercel preview deployments', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    // The exact origin from the reported failure.
    expect(
      isOriginAllowed(
        allowed,
        'https://lorekit-git-feat-header-activity-indicator-mads-thines-projects.vercel.app',
      ),
    ).toBe(true);
    // Per-commit deployment host and the `<project>-<scope>` production alias.
    expect(isOriginAllowed(allowed, 'https://lorekit-abc123-mads-thines-projects.vercel.app')).toBe(
      true,
    );
    expect(isOriginAllowed(allowed, 'https://lorekit-mads-thines-projects.vercel.app')).toBe(true);
  });

  it('does not admit another project or a spoofed Vercel host', () => {
    const allowed = expandAllowedOrigins(['https://lorekit.io']);
    // A different project on vercel.app.
    expect(isOriginAllowed(allowed, 'https://someone-else-projects.vercel.app')).toBe(false);
    // A `lorekit`-prefixed name that is a DIFFERENT word, not the project.
    expect(isOriginAllowed(allowed, 'https://lorekitten.vercel.app')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://notlorekit.vercel.app')).toBe(false);
    // A lookalike nesting the project name under an attacker subdomain.
    expect(isOriginAllowed(allowed, 'https://lorekit-x.attacker.vercel.app')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://lorekit.vercel.app.evil.com')).toBe(false);
    // Only HTTPS Vercel origins qualify.
    expect(isOriginAllowed(allowed, 'http://lorekit-preview.vercel.app')).toBe(false);
    // The reviewer's case: any tenant CAN name a project `lorekit-x`, but its
    // generated host ends with THEIR account scope, not ours, so it is rejected —
    // the scope suffix is the half a third party cannot forge.
    expect(isOriginAllowed(allowed, 'https://lorekit-x-someone-else-projects.vercel.app')).toBe(
      false,
    );
    expect(isOriginAllowed(allowed, 'https://lorekit-evil-attacker.vercel.app')).toBe(false);
    // The bare `<project>.vercel.app` alias (no account scope) is not admitted.
    expect(isOriginAllowed(allowed, 'https://lorekit.vercel.app')).toBe(false);
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
      // X-LoreKit-Client and X-LoreKit-Correlation-Id are load-bearing for the
      // BROWSER specifically: both are custom request headers, so a
      // cross-origin fetch that sets them is preflighted and fails outright
      // unless they are listed here. The dashboard sets X-LoreKit-Client on
      // every call (that is what keeps its own reads out of the "Memories
      // read" metric), so dropping it from this list does not merely lose a
      // telemetry dimension — it breaks every dashboard request.
      expect(headers['Access-Control-Allow-Headers']).toBe(
        'Authorization, Content-Type, traceparent, tracestate, X-LoreKit-Dry-Run, X-LoreKit-Client, X-LoreKit-Correlation-Id',
      );
      // Without this a browser cannot read the server span's traceparent, which
      // is what links client-side RUM to the server trace.
      expect(headers['Access-Control-Expose-Headers']).toBe('traceparent, X-LoreKit-Dry-Run');
      expect(headers['Access-Control-Max-Age']).toBe('86400');
      // Access-Control-Allow-Origin is origin-dependent, so the response MUST
      // declare it varies by Origin — otherwise a shared cache can serve one
      // origin's response to another. Present even for a disallowed origin.
      expect(headers['Vary']).toBe('Origin');
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

  it('echoes a Vercel preview origin back verbatim so the browser accepts it', () => {
    // The behaviour the failing preview deployment actually consumes: the header
    // is present and equals the request Origin, not `*`, even though the host is
    // not in the allowlist.
    const preview =
      'https://lorekit-git-feat-header-activity-indicator-mads-thines-projects.vercel.app';
    expect(corsResponseHeaders(ALLOWLIST, preview)['Access-Control-Allow-Origin']).toBe(preview);
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
