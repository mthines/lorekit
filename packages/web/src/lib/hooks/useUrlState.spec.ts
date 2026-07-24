/**
 * Tests for the pure helper functions exported from useUrlState.
 *
 * The hook itself depends on Next.js router internals (useSearchParams,
 * useRouter, usePathname) which require a full browser / jsdom + Next.js
 * test harness. Those integration tests belong in e2e or in a separate
 * setup once @testing-library/react is installed.
 *
 * What we test here (vitest node environment, zero DOM dependency):
 *   - serialise / deserialise round-trips
 *   - deserialise fallback on null and malformed input
 *   - toAbsolute path normalisation
 *   - buildUrl: param write, delete on default, preserve unrelated params
 *   - isPathnameAllowed: exact match, prefix match, non-match, array overload
 *
 * The optimistic-update contract is documented in the comments below as a
 * spec for future integration tests, and the SSR contract is documented via
 * the hook's JSDoc. Both depend on the router mock environment.
 */

import { describe, it, expect } from 'vitest';
import {
  serialise,
  deserialise,
  toAbsolute,
  buildUrl,
  isPathnameAllowed,
} from './useUrlState';

// ── serialise ─────────────────────────────────────────────────────────────────

describe('serialise', () => {
  it('serialises primitives to JSON strings', () => {
    expect(serialise(true)).toBe('true');
    expect(serialise(false)).toBe('false');
    expect(serialise(42)).toBe('42');
    expect(serialise('hello')).toBe('"hello"');
    expect(serialise(null)).toBe('null');
  });

  it('serialises objects and arrays', () => {
    expect(serialise({ scope: 'global', key: 'foo' })).toBe('{"scope":"global","key":"foo"}');
    expect(serialise(['a', 'b'])).toBe('["a","b"]');
  });

  it('serialises the same value deterministically (idempotent)', () => {
    const v = { key: 'k', scope: 's' };
    expect(serialise(v)).toBe(serialise(v));
  });
});

// ── deserialise ───────────────────────────────────────────────────────────────

describe('deserialise', () => {
  it('returns fallback when raw is null', () => {
    expect(deserialise(null, 'default')).toBe('default');
    expect(deserialise(null, null)).toBe(null);
    expect(deserialise(null, 42)).toBe(42);
  });

  it('returns fallback when raw is malformed JSON', () => {
    expect(deserialise('not-json', 'fallback')).toBe('fallback');
    expect(deserialise('{bad', null)).toBe(null);
    expect(deserialise('undefined', 0)).toBe(0);
  });

  it('round-trips primitives', () => {
    expect(deserialise(serialise(true), false)).toBe(true);
    expect(deserialise(serialise(false), true)).toBe(false);
    expect(deserialise(serialise(42), 0)).toBe(42);
    expect(deserialise(serialise('hello'), '')).toBe('hello');
    expect(deserialise(serialise(null), 'fallback')).toBe(null);
  });

  it('round-trips objects', () => {
    const obj = { scope: 'global', key: 'foo' };
    expect(deserialise(serialise(obj), null)).toEqual(obj);
  });

  it('round-trips arrays', () => {
    const arr = ['a', 'b', 'c'];
    expect(deserialise(serialise(arr), [])).toEqual(arr);
  });
});

// ── toAbsolute ────────────────────────────────────────────────────────────────

describe('toAbsolute', () => {
  it('prepends "/" when missing', () => {
    expect(toAbsolute('lore')).toBe('/lore');
    expect(toAbsolute('dashboard/stats')).toBe('/dashboard/stats');
  });

  it('does not double-prepend when "/" is already present', () => {
    expect(toAbsolute('/lore')).toBe('/lore');
    expect(toAbsolute('/dashboard')).toBe('/dashboard');
  });

  it('handles root path', () => {
    expect(toAbsolute('/')).toBe('/');
    expect(toAbsolute('')).toBe('/');
  });
});

// ── buildUrl ──────────────────────────────────────────────────────────────────

describe('buildUrl', () => {
  it('adds a param that does not yet exist', () => {
    const params = new URLSearchParams();
    const url = buildUrl('/lore', params, 'scope', 'global', null);
    expect(url).toBe('/lore?scope=%22global%22');
  });

  it('updates an existing param', () => {
    const params = new URLSearchParams('scope=%22global%22');
    const url = buildUrl('/lore', params, 'scope', 'project::lorekit', null);
    expect(url).toBe('/lore?scope=%22project%3A%3Alorekit%22');
  });

  it('removes the param when next equals defaultValue', () => {
    const params = new URLSearchParams('scope=%22global%22');
    // Setting to defaultValue (null) should delete the param.
    const url = buildUrl('/lore', params, 'scope', null, null);
    expect(url).toBe('/lore');
  });

  it('removes the param when next equals defaultValue (string default)', () => {
    const params = new URLSearchParams('q=%22hello%22');
    const url = buildUrl('/lore', params, 'q', '', '');
    expect(url).toBe('/lore');
  });

  it('preserves unrelated params', () => {
    const params = new URLSearchParams('other=value&scope=%22old%22');
    const url = buildUrl('/lore', params, 'scope', 'new', null);
    // unrelated param 'other' must survive
    expect(url).toContain('other=value');
    expect(url).toContain('scope=');
  });

  it('returns pathname without "?" when all params are removed', () => {
    const params = new URLSearchParams('scope=%22global%22');
    const url = buildUrl('/lore', params, 'scope', null, null);
    expect(url).not.toContain('?');
    expect(url).toBe('/lore');
  });

  it('handles boolean values', () => {
    const params = new URLSearchParams();
    const urlTrue = buildUrl('/lore', params, 'open', true, false);
    expect(urlTrue).toContain('open=true');
    // Boolean false is the default — should remove the param.
    const urlFalse = buildUrl('/lore', params, 'open', false, false);
    expect(urlFalse).toBe('/lore');
  });

  it('handles object values (lesson ref)', () => {
    const params = new URLSearchParams();
    const ref = { scope: 'global', key: 'foo' };
    const url = buildUrl('/dashboard', params, 'lesson', ref, null);
    expect(url).toContain('lesson=');
    // Decoding should round-trip
    const qs = new URLSearchParams(url.split('?')[1] ?? '');
    const decoded = JSON.parse(qs.get('lesson') ?? 'null');
    expect(decoded).toEqual(ref);
  });
});

// ── isPathnameAllowed ─────────────────────────────────────────────────────────

describe('isPathnameAllowed', () => {
  it('matches an exact pathname', () => {
    expect(isPathnameAllowed('/lore', '/lore')).toBe(true);
    expect(isPathnameAllowed('/dashboard', '/dashboard')).toBe(true);
  });

  it('matches a prefix (parent + child path)', () => {
    expect(isPathnameAllowed('/lore/edit', '/lore')).toBe(true);
    expect(isPathnameAllowed('/lore/deep/nest', '/lore')).toBe(true);
  });

  it('does NOT match a partial segment (no prefix bleed)', () => {
    // "/lorekit" should NOT match "/lore"
    expect(isPathnameAllowed('/lorekit', '/lore')).toBe(false);
    // "/dashboard-old" should NOT match "/dashboard"
    expect(isPathnameAllowed('/dashboard-old', '/dashboard')).toBe(false);
  });

  it('accepts an array of allowed paths (any match)', () => {
    expect(isPathnameAllowed('/lore', ['/dashboard', '/lore'])).toBe(true);
    expect(isPathnameAllowed('/activity', ['/dashboard', '/lore'])).toBe(false);
  });

  it('normalises paths that lack a leading slash', () => {
    expect(isPathnameAllowed('/lore', 'lore')).toBe(true);
    expect(isPathnameAllowed('/lore/edit', 'lore')).toBe(true);
  });

  it('handles root path', () => {
    expect(isPathnameAllowed('/', '/')).toBe(true);
    expect(isPathnameAllowed('/anything', '/')).toBe(true);
  });
});

/**
 * ── SSR contract (documented, not executed here) ──────────────────────────────
 *
 * During SSR, Next.js calls useSearchParams() and gets an empty ReadonlyURLSearchParams
 * object (no real URL is available server-side). This means:
 *
 *   deserialise(searchParams.get(key), defaultValue)
 *   ≡ deserialise(null, defaultValue)
 *   ≡ defaultValue
 *
 * So on the server, `urlValue` is always `defaultValue`. This matches what
 * React will show during the Suspense fallback shell. Once the client hydrates
 * inside the <Suspense> boundary, useSearchParams() returns the real URL params
 * and the component re-renders with the correct value. Because the Suspense
 * boundary separates the server-rendered shell from the client-rendered content,
 * there is no hydration mismatch.
 *
 * Requirement: every component that calls useUrlState MUST be rendered inside
 * a <Suspense> boundary (directly or via an ancestor). The layout.tsx wraps
 * <MemorySidebarProvider> in <Suspense fallback={null}> for this reason.
 *
 * ── Optimistic update contract (documented, not executed here) ─────────────────
 *
 * 1. User calls setState(next).
 * 2. setOptimisticValue(next) fires synchronously → re-render shows `next` immediately.
 * 3. router.replace(url) fires asynchronously → navigation starts.
 * 4. When navigation completes, searchParams changes → urlValue becomes `next`.
 * 5. useEffect detects serialise(urlValue) === serialise(optimisticValue) → sets
 *    optimisticValue back to null (URL is now the source of truth again).
 * 6. External URL changes (back button, direct link) update searchParams → urlValue
 *    changes → if optimisticValue !== null and doesn't match, it stays until it
 *    matches or a new setState overrides it. In practice this is fine because
 *    the user's intent (the optimistic value) will be overridden by the navigation.
 *
 * Integration tests for this contract require @testing-library/react + vitest
 * with jsdom environment. Add these when the web package gains those devDeps.
 */
