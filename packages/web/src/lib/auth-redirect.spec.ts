import { describe, it, expect } from 'vitest';
import {
  safeNextPath,
  boundedReturnTo,
  DEFAULT_POST_LOGIN_PATH,
  MAX_RETURN_TO_CHARS,
} from './auth-redirect';

describe('safeNextPath', () => {
  it('returns the fallback for null / undefined / empty input', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeNextPath('')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('accepts a same-origin absolute path', () => {
    expect(safeNextPath('/lore')).toBe('/lore');
    expect(safeNextPath('/lore?lesson=abc&x=1')).toBe('/lore?lesson=abc&x=1');
    expect(safeNextPath('/settings/user#top')).toBe('/settings/user#top');
  });

  it('rejects scheme-relative URLs (open-redirect vector)', () => {
    expect(safeNextPath('//evil.com')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeNextPath('//evil.com/path')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('rejects backslash-prefixed paths browsers may normalise to //', () => {
    expect(safeNextPath('/\\evil.com')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('rejects absolute URLs and relative paths without a leading slash', () => {
    expect(safeNextPath('https://evil.com')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeNextPath('dashboard')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('honours a caller-supplied fallback', () => {
    expect(safeNextPath(null, '/update-password')).toBe('/update-password');
    expect(safeNextPath('//evil.com', '/update-password')).toBe('/update-password');
  });
});

describe('boundedReturnTo', () => {
  it('keeps the query string when it fits the header budget', () => {
    expect(boundedReturnTo('/lore', '?filters=%5B%5D')).toBe('/lore?filters=%5B%5D');
  });

  it('keeps a bare pathname unchanged', () => {
    expect(boundedReturnTo('/overview', '')).toBe('/overview');
  });

  it('keeps a return trip of exactly the budget', () => {
    const search = `?f=${'x'.repeat(MAX_RETURN_TO_CHARS - '/lore?f='.length)}`;
    expect(boundedReturnTo('/lore', search)).toHaveLength(MAX_RETURN_TO_CHARS);
  });

  /**
   * The case this exists for: a filter bar wide enough that carrying it through
   * login would be a `431` rather than a redirect. The user loses the bar and
   * lands on the page; they do not lose the page.
   */
  it('drops an oversized query string rather than carrying it into a header', () => {
    const search = `?filters=${'x'.repeat(MAX_RETURN_TO_CHARS)}`;
    expect(boundedReturnTo('/lore', search)).toBe('/lore');
  });
});
