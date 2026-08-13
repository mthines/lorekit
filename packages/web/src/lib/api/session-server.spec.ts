import { describe, it, expect, afterEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({ auth: { getSession } }),
}));

import { serverAccessToken } from './session-server';

afterEach(() => {
  delete process.env['LOREKIT_LOCAL_MODE'];
  getSession.mockReset();
});

describe('serverAccessToken', () => {
  it('local mode: returns the fixed sentinel without ever touching Supabase auth', async () => {
    process.env['LOREKIT_LOCAL_MODE'] = '1';
    const token = await serverAccessToken();
    expect(token).toBe('lorekit-local-dev-mode');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('local mode is gated on the exact string "1" — any other value falls through to real auth', async () => {
    process.env['LOREKIT_LOCAL_MODE'] = 'yes';
    getSession.mockResolvedValue({ data: { session: { access_token: 'real-token' } } });
    const token = await serverAccessToken();
    expect(token).toBe('real-token');
  });

  it('INVARIANT: with the flag unset, returns the real session token exactly as before this branch existed', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'real-token' } } });
    const token = await serverAccessToken();
    expect(token).toBe('real-token');
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('INVARIANT: with the flag unset and no session, resolves to null — not authenticated', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const token = await serverAccessToken();
    expect(token).toBeNull();
  });

  it('the server sentinel matches the browser sentinel — the shim needs only ONE non-empty token, not two', async () => {
    process.env['LOREKIT_LOCAL_MODE'] = '1';
    const { LOCAL_MODE_TOKEN } = await import('@/lib/local-mode');
    expect(await serverAccessToken()).toBe(LOCAL_MODE_TOKEN);
  });
});
