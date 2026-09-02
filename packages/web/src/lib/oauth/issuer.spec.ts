import { describe, it, expect } from 'vitest';
import { DEFAULT_ISSUER } from './metadata';
import { issuerCacheControl, resolveIssuer } from './issuer';

const PREVIEW_ALIAS = 'https://lorekit-git-feat-x.vercel.app';
const REQUEST_ORIGIN = 'https://lorekit-3zw28wfrv.vercel.app';

describe('resolveIssuer — production', () => {
  it('uses the configured canonical origin', () => {
    expect(
      resolveIssuer({ vercelEnv: 'production', appUrl: 'https://lorekit.io' }),
    ).toEqual({ issuer: 'https://lorekit.io', derivedFromRequest: false });
  });

  it('prefers configuration over the request', () => {
    // A Host header must never be able to redirect a production document.
    const resolved = resolveIssuer(
      { vercelEnv: 'production', appUrl: 'https://lorekit.io' },
      'https://evil.example',
    );
    expect(resolved.issuer).toBe('https://lorekit.io');
    expect(resolved.derivedFromRequest).toBe(false);
  });
});

describe('resolveIssuer — local development', () => {
  it('uses NEXT_PUBLIC_APP_URL from .env.local', () => {
    expect(resolveIssuer({ appUrl: 'http://localhost:3001' }).issuer).toBe(
      'http://localhost:3001',
    );
  });
});

describe('resolveIssuer — preview', () => {
  it('uses the stable branch alias when the build knew it', () => {
    const resolved = resolveIssuer({
      vercelEnv: 'preview',
      appUrl: 'https://lorekit.io',
      vercelUrl: PREVIEW_ALIAS,
    });
    expect(resolved).toEqual({ issuer: PREVIEW_ALIAS, derivedFromRequest: false });
  });

  it('falls back to the request origin when the prebuilt CLI deploy knew nothing', () => {
    // This is the /preview workflow's path: `vercel build` runs on the runner,
    // where neither VERCEL_BRANCH_URL nor VERCEL_URL is populated.
    const resolved = resolveIssuer(
      { vercelEnv: 'preview', appUrl: 'https://lorekit.io', vercelUrl: '' },
      REQUEST_ORIGIN,
    );
    expect(resolved).toEqual({ issuer: REQUEST_ORIGIN, derivedFromRequest: true });
  });

  it('never uses NEXT_PUBLIC_APP_URL on a preview, even though it is set', () => {
    // The whole point. NEXT_PUBLIC_APP_URL is pulled from Vercel and still
    // holds production on a preview build, so honouring it would advertise
    // production endpoints from a preview and mint a token for the wrong
    // deployment. Every preview branch resolves elsewhere.
    const withAlias = resolveIssuer({
      vercelEnv: 'preview',
      appUrl: 'https://app-url.example',
      vercelUrl: PREVIEW_ALIAS,
    });
    const withRequest = resolveIssuer(
      { vercelEnv: 'preview', appUrl: 'https://app-url.example' },
      REQUEST_ORIGIN,
    );
    expect(withAlias.issuer).toBe(PREVIEW_ALIAS);
    expect(withRequest.issuer).toBe(REQUEST_ORIGIN);
  });

  it('falls back to the default only when nothing at all is known', () => {
    // Unreachable from a route handler (a request always has an origin), but a
    // total function has to return something and a document must be emitted.
    expect(resolveIssuer({ vercelEnv: 'preview', appUrl: 'https://lorekit.io' }).issuer).toBe(
      DEFAULT_ISSUER,
    );
  });
});

describe('resolveIssuer — normalisation', () => {
  it('strips a trailing slash from every source', () => {
    expect(resolveIssuer({ appUrl: 'https://lorekit.io/' }).issuer).toBe('https://lorekit.io');
    expect(
      resolveIssuer({ vercelEnv: 'preview', vercelUrl: `${PREVIEW_ALIAS}/` }).issuer,
    ).toBe(PREVIEW_ALIAS);
    expect(resolveIssuer({}, `${REQUEST_ORIGIN}/`).issuer).toBe(REQUEST_ORIGIN);
  });

  it('treats an empty string as unset', () => {
    expect(resolveIssuer({ appUrl: '' }, REQUEST_ORIGIN).issuer).toBe(REQUEST_ORIGIN);
    expect(resolveIssuer({ appUrl: '' }, '').issuer).toBe(DEFAULT_ISSUER);
  });
});

describe('issuerCacheControl', () => {
  it('forbids caching a request-derived document', () => {
    // Coupled on purpose: a request-derived origin in a shared CDN cache is a
    // cache-poisoning primitive.
    expect(issuerCacheControl({ issuer: REQUEST_ORIGIN, derivedFromRequest: true })).toBe(
      'no-store',
    );
  });

  it('allows caching a configured document', () => {
    expect(
      issuerCacheControl({ issuer: 'https://lorekit.io', derivedFromRequest: false }),
    ).toContain('s-maxage=3600');
  });
});
