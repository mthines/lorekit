import { describe, expect, it, vi } from 'vitest';
import { ensureFlagAnonIdCookie, FLAG_ANON_ID_COOKIE } from './anon-id';

const ANON_ID_PATTERN = /^anon:[0-9a-f-]{36}$/;

function fakeRequestCookies(seed: Record<string, string> = {}) {
  return { get: (name: string) => (name in seed ? { value: seed[name] } : undefined) };
}

describe('ensureFlagAnonIdCookie', () => {
  it('mints and sets a cookie when the request carries none', () => {
    const set = vi.fn();
    ensureFlagAnonIdCookie(fakeRequestCookies(), { set });

    expect(set).toHaveBeenCalledTimes(1);
    const [name, value, options] = set.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe(FLAG_ANON_ID_COOKIE);
    expect(value).toMatch(ANON_ID_PATTERN);
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('does nothing when the request already carries the cookie', () => {
    const set = vi.fn();
    ensureFlagAnonIdCookie(fakeRequestCookies({ [FLAG_ANON_ID_COOKIE]: 'anon:existing' }), {
      set,
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('mints a different id on two separate calls with no existing cookie', () => {
    const first = vi.fn();
    const second = vi.fn();
    ensureFlagAnonIdCookie(fakeRequestCookies(), { set: first });
    ensureFlagAnonIdCookie(fakeRequestCookies(), { set: second });
    expect(first.mock.calls[0]?.[1]).not.toBe(second.mock.calls[0]?.[1]);
  });
});
