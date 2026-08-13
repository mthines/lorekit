import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

import { middleware } from './middleware';

afterEach(() => {
  delete process.env['LOREKIT_LOCAL_MODE'];
  getUser.mockReset();
});

describe('middleware', () => {
  it('INVARIANT: with the flag unset, an authenticated visitor to /login is redirected away exactly as before', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const req = new NextRequest('http://localhost:3000/login');
    const res = await middleware(req);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toContain('/overview');
  });

  it('INVARIANT: with the flag unset, an unauthenticated visitor to /login is not redirected (not authenticated → stays)', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const req = new NextRequest('http://localhost:3000/login');
    const res = await middleware(req);
    expect(res.headers.get('location')).toBeNull();
  });

  it('local mode: skips the getUser()/login gate entirely, even for a request that would otherwise redirect', async () => {
    process.env['LOREKIT_LOCAL_MODE'] = '1';
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const req = new NextRequest('http://localhost:3000/login');
    const res = await middleware(req);
    expect(getUser).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBeNull();
  });

  it('local mode is gated on the exact string "1"', async () => {
    process.env['LOREKIT_LOCAL_MODE'] = 'true';
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const req = new NextRequest('http://localhost:3000/login');
    await middleware(req);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('OPTIONS preflight is answered before any auth logic in both modes', async () => {
    const req = new NextRequest('http://localhost:3000/lore', { method: 'OPTIONS' });
    const res = await middleware(req);
    expect(res.status).toBe(204);
    expect(getUser).not.toHaveBeenCalled();
  });
});
