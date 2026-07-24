/**
 * Smoke tests for the core memory tools (write / read / list / search)
 * wired through the MCP server.
 *
 * Tests the full call path: tool registration → handler → @lorekit/core function.
 * The Supabase client and @lorekit/core tool functions are mocked so no DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock @lorekit/core ─────────────────────────────────────────────────────────
const {
  mockWrite,
  mockRead,
  mockList,
  mockSearch,
} = vi.hoisted(() => ({
  mockWrite:  vi.fn(),
  mockRead:   vi.fn(),
  mockList:   vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock('@lorekit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorekit/core')>();
  return {
    ...actual,
    createServiceClient: vi.fn(() => ({})),
    createUserClient:    vi.fn(() => ({})),
    write:               mockWrite,
    read:                mockRead,
    list:                mockList,
    search:              mockSearch,
    // pass-through for archive/delete/purge (not under test here)
    archiveMemory:  vi.fn().mockResolvedValue({ archived: false }),
    restoreMemory:  vi.fn().mockResolvedValue({ restored: false }),
    listArchived:   vi.fn().mockResolvedValue({ entries: [] }),
    purgeArchived:  vi.fn().mockResolvedValue({ purged: 0 }),
    deleteMemory:   vi.fn().mockResolvedValue({ deleted: false, archived: false }),
  };
});

// ── import server AFTER mocks ─────────────────────────────────────────────────
import { createMcpServer } from './server.js';

const SERVICE_AUTH = { type: 'service' as const };

// ── helper ────────────────────────────────────────────────────────────────────

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const server = createMcpServer(SERVICE_AUTH);
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client.callTool({ name: toolName, arguments: args });
}

function parseResult(result: unknown): unknown {
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(text);
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

// ── memory.write ──────────────────────────────────────────────────────────────

describe('memory.write', () => {
  it('routes to write and returns id + created_at', async () => {
    const payload = { id: 'uuid-1', created_at: '2026-01-01T00:00:00Z' };
    mockWrite.mockResolvedValue(payload);

    const result = await callTool('memory.write', { scope: 'global', key: 'k', value: 'v' });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'global', key: 'k', value: 'v' }),
    );
    expect(parseResult(result)).toMatchObject(payload);
  });

  it('forwards optional tags, source_agent and trigger', async () => {
    mockWrite.mockResolvedValue({ id: 'uuid-2', created_at: '2026-01-01T00:00:00Z' });
    await callTool('memory.write', {
      scope: 'repo::mthines/gw-tools',
      key: 'lesson',
      value: 'body',
      tags: ['skill::aw'],
      source_agent: 'aw-executor',
      trigger: 'stuck-loop',
    });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ['skill::aw'], source_agent: 'aw-executor', trigger: 'stuck-loop' }),
    );
  });
});

// ── memory.read ───────────────────────────────────────────────────────────────

describe('memory.read', () => {
  it('routes to read and returns value + updated_at', async () => {
    const payload = { value: 'Always use worktree isolation', updated_at: '2026-01-01T00:00:00Z' };
    mockRead.mockResolvedValue(payload);

    const result = await callTool('memory.read', { scope: 'global', key: 'lesson-a' });
    expect(mockRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'global', key: 'lesson-a' }),
    );
    expect(parseResult(result)).toMatchObject(payload);
  });

  it('returns null when the key is not found', async () => {
    mockRead.mockResolvedValue(null);
    const result = await callTool('memory.read', { scope: 'global', key: 'missing' });
    expect(parseResult(result)).toBeNull();
  });
});

// ── memory.list ───────────────────────────────────────────────────────────────

describe('memory.list', () => {
  const fakeEntries = [
    { key: 'k1', value: 'v1', tags: ['skill::aw'], updated_at: '2026-01-01T00:00:00Z' },
    { key: 'k2', value: 'v2', tags: [], updated_at: '2026-01-02T00:00:00Z' },
  ];

  it('routes to list and returns entries', async () => {
    mockList.mockResolvedValue({ entries: fakeEntries });
    const result = await callTool('memory.list', { scope: 'global' });
    expect(mockList).toHaveBeenCalledOnce();
    const parsed = parseResult(result) as { entries: unknown[] };
    expect(parsed.entries).toHaveLength(2);
  });

  it('returns empty entries when scope has no lessons', async () => {
    mockList.mockResolvedValue({ entries: [] });
    const result = await callTool('memory.list', { scope: 'project::empty-project' });
    expect(parseResult(result)).toMatchObject({ entries: [] });
  });

  it('forwards optional tags and limit', async () => {
    mockList.mockResolvedValue({ entries: [] });
    await callTool('memory.list', { scope: 'global', tags: ['skill::aw'], limit: 10 });
    expect(mockList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ['skill::aw'], limit: 10 }),
    );
  });
});

// ── memory.search ─────────────────────────────────────────────────────────────

describe('memory.search', () => {
  const fakeEntries = [
    { key: 'k1', value: 'worktree isolation', scope: 'global', tags: [], rank: 1 },
  ];

  it('routes to search and returns entries with rank', async () => {
    mockSearch.mockResolvedValue({ entries: fakeEntries });
    const result = await callTool('memory.search', { q: 'worktree' });
    expect(mockSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: 'worktree' }),
    );
    const parsed = parseResult(result) as { entries: Array<{ rank: number }> };
    expect(parsed.entries[0]!.rank).toBe(1);
  });

  it('returns empty entries when nothing matches', async () => {
    mockSearch.mockResolvedValue({ entries: [] });
    const result = await callTool('memory.search', { q: 'unfindable' });
    expect(parseResult(result)).toMatchObject({ entries: [] });
  });

  it('forwards optional scopes, tags and limit', async () => {
    mockSearch.mockResolvedValue({ entries: [] });
    await callTool('memory.search', {
      q: 'test',
      scopes: ['global', 'repo::mthines/*'],
      tags: ['skill::aw'],
      limit: 5,
    });
    expect(mockSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scopes: ['global', 'repo::mthines/*'], tags: ['skill::aw'], limit: 5 }),
    );
  });
});
