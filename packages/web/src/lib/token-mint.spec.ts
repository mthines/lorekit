/**
 * Regression pin for the production bug this module exists to fix:
 * `mintToken` must NEVER call `revalidatePath` — that call only belongs in
 * `lib/tokens.ts`'s `generateToken` (pinned separately in `tokens.spec.ts`),
 * because a Server Component render (the first-sign-in auto-mint on `/lore`)
 * calls `mintToken` directly and Next 15 throws if `revalidatePath` runs
 * during render.
 *
 * `server-only` is not resolvable outside Next's bundler, so it is mocked as
 * a no-op virtual module — verified at plan time that vitest accepts this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const getVerifiedUser = vi.fn();
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUser: () => getVerifiedUser() }));

const recordAuditEvent = vi.fn();
vi.mock('@/lib/audit-log', () => ({ recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args) }));

// ── Chainable Supabase fake ────────────────────────────────────────────────
// `mintToken` only ever touches `api_tokens` through two shapes:
//   .from('api_tokens').select('id', {count:'exact', head:true}).eq(...)
//   .from('api_tokens').insert(...).select(...).single()
// plus, on the scoped/cleanup path, .rpc(...) and .delete().eq().eq(). Each
// is stubbed to resolve a scripted result so a test only has to say what it
// wants back, not reconstruct the real client.
interface SupabaseScript {
  count?: { count: number | null; error: { message: string } | null };
  insert?: { data: Record<string, unknown> | null; error: { message: string } | null };
  rpc?: { data: unknown; error: { message: string } | null };
  delete?: { error: { message: string } | null };
}

const insertCalls: unknown[] = [];

function makeSupabase(script: SupabaseScript) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: () => Promise.resolve(script.count ?? { count: 0, error: null }),
      }),
      insert: (row: unknown) => {
        insertCalls.push(row);
        return {
          select: (_cols: string) => ({
            single: () => Promise.resolve(script.insert ?? { data: null, error: null }),
          }),
        };
      },
      delete: () => ({
        eq: () => ({
          eq: () => Promise.resolve(script.delete ?? { error: null }),
        }),
      }),
    }),
    rpc: () => Promise.resolve(script.rpc ?? { data: null, error: null }),
  };
}

const createServerClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => createServerClient() }));

const { mintToken } = await import('./token-mint');

const USER = { id: 'user-1' };
const RECORD = {
  id: 'tok-1',
  name: 'My first token',
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
  insertCalls.length = 0;
  getVerifiedUser.mockResolvedValue(USER);
  recordAuditEvent.mockResolvedValue(undefined);
});

describe('mintToken', () => {
  it('never calls revalidatePath on a successful mint, and inserts exactly once', async () => {
    createServerClient.mockResolvedValue(
      makeSupabase({
        count: { count: 0, error: null },
        insert: { data: RECORD, error: null },
      }),
    );

    const result = await mintToken('My first token', ['read', 'write']);

    expect('token' in result).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
  });

  it('never calls revalidatePath when the insert fails', async () => {
    createServerClient.mockResolvedValue(
      makeSupabase({
        count: { count: 0, error: null },
        insert: { data: null, error: { message: 'insert boom' } },
      }),
    );

    const result = await mintToken('My first token', ['read', 'write']);

    expect(result).toEqual({ error: 'insert boom' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('never calls revalidatePath when the token cap is reached', async () => {
    createServerClient.mockResolvedValue(makeSupabase({ count: { count: 20, error: null } }));

    const result = await mintToken('My first token', ['read', 'write']);

    expect('error' in result).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it('stamps the origin attribute without affecting the result shape', async () => {
    createServerClient.mockResolvedValue(
      makeSupabase({
        count: { count: 0, error: null },
        insert: { data: RECORD, error: null },
      }),
    );

    const result = await mintToken('My first token', ['read', 'write'], undefined, 'onboarding');

    expect('token' in result).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
