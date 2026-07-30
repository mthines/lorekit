import { describe, it, expect } from 'vitest';
import { safeNextPath, DEFAULT_POST_LOGIN_PATH } from './auth-redirect';

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
