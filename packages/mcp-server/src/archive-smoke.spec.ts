/**
 * Smoke tests for archive / restore / purge tool wiring in the MCP server.
 *
 * Tests the full call path: tool registration → handler → @lorekit/core function.
 * The Supabase client and @lorekit/core tool functions are mocked so no DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock @lorekit/core ─────────────────────────────────────────────────────────
// vi.mock is hoisted; factory must not reference variables declared outside it.
// Use vi.hoisted() to declare the mock fns first so hoisting order is correct.

const {
  mockArchiveMemory,
  mockRestoreMemory,
  mockListArchived,
  mockPurgeArchived,
  mockDeleteMemory,
  mockWrite,
  mockRead,
  mockList,
  mockSearch,
} = vi.hoisted(() => ({
  mockArchiveMemory:  vi.fn(),
  mockRestoreMemory:  vi.fn(),
  mockListArchived:   vi.fn(),
  mockPurgeArchived:  vi.fn(),
  mockDeleteMemory:   vi.fn(),
  mockWrite:          vi.fn(),
  mockRead:           vi.fn(),
  mockList:           vi.fn(),
  mockSearch:         vi.fn(),
}));

vi.mock('@lorekit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorekit/core')>();
  return {
    ...actual,
    createServiceClient: vi.fn(() => ({})),
    createUserClient:    vi.fn(() => ({})),
    archiveMemory:  mockArchiveMemory,
    restoreMemory:  mockRestoreMemory,
    listArchived:   mockListArchived,
    purgeArchived:  mockPurgeArchived,
    deleteMemory:   mockDeleteMemory,
    write:          mockWrite,
    read:           mockRead,
    list:           mockList,
    search:         mockSearch,
  };
});

// ── import server AFTER mocks ─────────────────────────────────────────────────
import { createMcpServer } from './server.js';

const SERVICE_AUTH = { type: 'service' as const };

// ── helper ────────────────────────────────────────────────────────────────────
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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

describe('memory.delete — soft-archive default', () => {
  it('routes to deleteMemory and returns archived: true', async () => {
    mockDeleteMemory.mockResolvedValue({ deleted: false, archived: true });
    const result = await callTool('memory.delete', { scope: 'global', key: 'k1' });
    expect(mockDeleteMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'global', key: 'k1' }),
    );
    expect(parseResult(result)).toMatchObject({ deleted: false, archived: true });
  });

  it('routes to deleteMemory with force: true for hard-delete', async () => {
    mockDeleteMemory.mockResolvedValue({ deleted: true, archived: false });
    await callTool('memory.delete', { scope: 'global', key: 'k1', force: true });
    expect(mockDeleteMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ force: true }),
    );
  });
});

describe('memory.archive', () => {
  it('routes to archiveMemory and returns archived: true', async () => {
    mockArchiveMemory.mockResolvedValue({ archived: true });
    const result = await callTool('memory.archive', { scope: 'global', key: 'k1' });
    expect(mockArchiveMemory).toHaveBeenCalledOnce();
    expect(parseResult(result)).toMatchObject({ archived: true });
  });

  it('returns archived: false when already archived', async () => {
    mockArchiveMemory.mockResolvedValue({ archived: false });
    const result = await callTool('memory.archive', { scope: 'global', key: 'gone' });
    expect(parseResult(result)).toMatchObject({ archived: false });
  });
});

describe('memory.restore', () => {
  it('routes to restoreMemory and returns restored: true', async () => {
    mockRestoreMemory.mockResolvedValue({ restored: true });
    const result = await callTool('memory.restore', { scope: 'global', key: 'k1' });
    expect(mockRestoreMemory).toHaveBeenCalledOnce();
    expect(parseResult(result)).toMatchObject({ restored: true });
  });
});

describe('memory.list_archived', () => {
  const fakeEntries = [
    { key: 'k1', value: 'v', tags: [], updated_at: '2026-01-01T00:00:00Z', archived_at: '2026-03-01T00:00:00Z' },
  ];

  it('routes to listArchived and returns entries', async () => {
    mockListArchived.mockResolvedValue({ entries: fakeEntries });
    const result = await callTool('memory.list_archived', { scope: 'global' });
    expect(mockListArchived).toHaveBeenCalledOnce();
    expect((parseResult(result) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('returns empty entries when archive is empty', async () => {
    mockListArchived.mockResolvedValue({ entries: [] });
    const result = await callTool('memory.list_archived', { scope: 'global' });
    expect(parseResult(result)).toMatchObject({ entries: [] });
  });
});

describe('memory.purge', () => {
  it('routes to purgeArchived and returns purged count', async () => {
    mockPurgeArchived.mockResolvedValue({ purged: 5 });
    const result = await callTool('memory.purge', { retention_days: 7 });
    expect(mockPurgeArchived).toHaveBeenCalledOnce();
    expect(parseResult(result)).toMatchObject({ purged: 5 });
  });

  it('works with no arguments (uses default retention_days)', async () => {
    mockPurgeArchived.mockResolvedValue({ purged: 0 });
    await callTool('memory.purge', {});
    expect(mockPurgeArchived).toHaveBeenCalledOnce();
  });
});
