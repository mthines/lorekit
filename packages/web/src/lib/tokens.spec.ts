/**
 * `generateToken` (the `'use server'` action, triggered by the dashboard's
 * "Generate token" button) is the one place in the app a mint is followed by
 * a revalidate — it runs from a form submission, never a render. This pins
 * that it revalidates BOTH `/lore` and the `/settings` layout on success, and
 * revalidates NOTHING when the mint fails — the render-path mint
 * (`token-mint.spec.ts`) must never revalidate at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const mintToken = vi.fn();
vi.mock('@/lib/token-mint', () => ({
  mintToken: (...args: unknown[]) => mintToken(...args),
  applyScoping: vi.fn(),
  TOKEN_COLUMNS: 'id, name, token_prefix, permissions, scopes, org_access, org_ids, last_used_at, created_at',
}));

const getVerifiedUser = vi.fn();
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUser: () => getVerifiedUser() }));

const createServerClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => createServerClient() }));

vi.mock('@/lib/audit-log', () => ({ recordAuditEvent: vi.fn() }));

const { generateToken } = await import('./tokens');

const RECORD = {
  id: 'tok-1',
  name: 'My token',
  token_prefix: 'lk_rw_aBcD1...',
  permissions: ['read', 'write'],
  scopes: [],
  org_access: 'all',
  org_ids: [],
  last_used_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateToken', () => {
  it('revalidates /lore and the /settings layout on success', async () => {
    mintToken.mockResolvedValue({ token: 'lk_rw_xyz', record: RECORD });

    const result = await generateToken('My token', ['read', 'write']);

    expect(result).toEqual({ token: 'lk_rw_xyz', record: RECORD });
    expect(mintToken).toHaveBeenCalledWith(
      'My token',
      ['read', 'write'],
      { scopes: [], org_access: 'all', org_ids: [] },
      'dashboard',
    );
    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(revalidatePath).toHaveBeenNthCalledWith(1, '/lore');
    expect(revalidatePath).toHaveBeenNthCalledWith(2, '/settings', 'layout');
  });

  it('revalidates nothing when the mint returns an error', async () => {
    mintToken.mockResolvedValue({ error: 'boom' });

    const result = await generateToken('My token', ['read', 'write']);

    expect(result).toEqual({ error: 'boom' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
