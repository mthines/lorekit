/**
 * Tests for the updateLesson server action (pure logic paths).
 *
 * We mock the Supabase server client so no live DB is needed. These tests run
 * in the `node` environment (no DOM) and cover:
 *
 * - Unauthenticated users receive an error.
 * - A missing/archived memory returns an error.
 * - A successful update calls `memory_write` with the correct arguments and
 *   revalidates the /lore path.
 * - A DB error from `memory_write` is forwarded as an error string.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Prevent `revalidatePath` from throwing in the test environment.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// We need to mock the Supabase server client BEFORE importing updateLesson,
// because `lore.ts` calls createServerClient at module-evaluation time when
// the function body executes (it's async but the import of `createServerClient`
// itself is hoisted).

const mockRpc = vi.fn();
const mockSingle = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockIs = vi.fn();

// Chain: supabase.from(...).select(...).eq(...).eq(...).eq(...).is(...).single()
// Each method returns an object with all other chain methods so any ordering works.
function makeChain(terminalFn: Mock) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'is', 'single'];
  for (const m of methods) {
    chain[m] = vi.fn(() => {
      if (m === 'single') return terminalFn();
      return chain;
    });
  }
  return chain;
}

const mockRpcChain = {
  single: mockSingle,
};

const mockFromChain = makeChain(mockSingle);

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(() => mockFromChain),
  rpc: vi.fn(() => mockRpcChain),
};

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => mockSupabase),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

const { updateLesson } = await import('./lore');
const { revalidatePath } = await import('next/cache');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('updateLesson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated user.
    (mockSupabase.auth.getUser as Mock).mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
  });

  it('returns an error when the user is not authenticated', async () => {
    (mockSupabase.auth.getUser as Mock).mockResolvedValue({ data: { user: null } });

    const result = await updateLesson('global', 'my-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toMatch(/not authenticated/i);
  });

  it('returns an error when the memory row is not found', async () => {
    // The .single() call for the current-row fetch fails.
    (mockFromChain.single as Mock).mockReturnValue({
      data: null,
      error: { message: 'Row not found' },
    });

    const result = await updateLesson('global', 'missing-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toBe('Row not found');
    // memory_write should not be called.
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('calls memory_write with the correct parameters and returns the id on success', async () => {
    // Successful current-row fetch.
    (mockFromChain.single as Mock).mockReturnValue({
      data: { source_agent: 'agent0', trigger: 'hook' },
      error: null,
    });
    // Successful memory_write RPC.
    mockSingle.mockResolvedValue({
      data: { id: 'mem-abc', created_at: '2026-07-01T00:00:00Z', inserted: false },
      error: null,
    });

    const result = await updateLesson('project::myproject', 'my-key', {
      value: 'Updated value',
      tags: ['tag1', 'tag2'],
    });

    expect(result.id).toBe('mem-abc');
    expect(result.error).toBeUndefined();

    expect(mockSupabase.rpc).toHaveBeenCalledWith('memory_write', {
      p_user_id: 'user-123',
      p_scope: 'project::myproject',
      p_key: 'my-key',
      p_value: 'Updated value',
      p_tags: ['tag1', 'tag2'],
      p_source_agent: 'agent0',
      p_trigger: 'hook',
      p_created_at: null,
    });

    expect(revalidatePath).toHaveBeenCalledWith('/lore');
  });

  it('returns a DB error string when memory_write fails', async () => {
    (mockFromChain.single as Mock).mockReturnValue({
      data: { source_agent: null, trigger: null },
      error: null,
    });
    mockSingle.mockResolvedValue({
      data: null,
      error: { message: 'memory_cap: too many memories' },
    });

    const result = await updateLesson('global', 'my-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toBe('memory_cap: too many memories');
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('preserves source_agent and trigger from the fetched row', async () => {
    (mockFromChain.single as Mock).mockReturnValue({
      data: { source_agent: 'claude-3', trigger: 'pre_tool_use' },
      error: null,
    });
    mockSingle.mockResolvedValue({
      data: { id: 'mem-xyz', inserted: false },
      error: null,
    });

    await updateLesson('global', 'k', { value: 'new-val', tags: [] });

    const rpcCall = (mockSupabase.rpc as Mock).mock.calls[0];
    const args = rpcCall?.[1] as Record<string, unknown>;
    expect(args['p_source_agent']).toBe('claude-3');
    expect(args['p_trigger']).toBe('pre_tool_use');
  });
});
