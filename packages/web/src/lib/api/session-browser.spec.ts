import { describe, it, expect, afterEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}));

import { browserAccessToken } from './session-browser';

afterEach(() => {
  delete process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'];
  getSession.mockReset();
});

describe('browserAccessToken', () => {
  it('local mode: returns the fixed sentinel without ever touching Supabase auth', async () => {
    process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] = '1';
    const token = await browserAccessToken();
    expect(token).toBe('lorekit-local-dev-mode');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('local mode is gated on the exact string "1" — any other value falls through to real auth', async () => {
    process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] = 'true';
    getSession.mockResolvedValue({ data: { session: { access_token: 'real-token' } } });
    const token = await browserAccessToken();
    expect(token).toBe('real-token');
  });

  it('INVARIANT: with the flag unset, returns the real session token exactly as before this branch existed', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'real-token' } } });
    const token = await browserAccessToken();
    expect(token).toBe('real-token');
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('INVARIANT: with the flag unset and no session, resolves to null — not authenticated', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const token = await browserAccessToken();
    expect(token).toBeNull();
  });
});
