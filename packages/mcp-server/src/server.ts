/**
 * LoreKit MCP Server
 * Registers the five memory tools and exposes them via StreamableHTTP transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  write,
  read,
  list,
  deleteMemory,
  search,
  archiveMemory,
  restoreMemory,
  listArchived,
  purgeArchived,
  createUserClient,
  createServiceClient,
  checkRateLimit,
  rateLimitMessage,
  LimitError,
} from '@lorekit/core';
import { type AuthContext } from './auth.js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

function getDb(auth: AuthContext) {
  if (auth.type === 'service') {
    return createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return createUserClient(SUPABASE_URL, SUPABASE_ANON_KEY, auth.jwt!);
}

export function createMcpServer(auth: AuthContext): McpServer {
  const server = new McpServer({ name: 'lorekit', version: '0.0.1' });
  const db = getDb(auth);

  server.tool(
    'memory.write',
    'Store or update a memory/lesson entry at a canonical scope.',
    {
      scope: z.string().describe('Canonical scope: global | project::name | repo::owner/repo | branch::owner/repo::branch'),
      key: z.string().describe('Lesson key identifier'),
      value: z.string().describe('Lesson body (markdown, max 64KB)'),
      tags: z.array(z.string()).optional().describe('Optional tags e.g. ["skill::aw", "source::manual"]'),
      source_agent: z.string().optional().describe('Agent that wrote this lesson'),
      trigger: z.string().optional().describe('What triggered this write e.g. "stuck-loop"'),
    },
    async (args) => {
      try {
        const result = await write(db, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof LimitError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    },
  );

  server.tool(
    'memory.read',
    'Read a single memory entry by scope and key.',
    {
      scope: z.string(),
      key: z.string(),
    },
    async (args) => {
      const result = await read(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.list',
    'List memory entries for a given scope, optionally filtered by tags.',
    {
      scope: z.string(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const result = await list(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.delete',
    'Soft-archive a memory entry (default) or hard-delete it (force: true). Archived entries can be restored.',
    {
      scope: z.string(),
      key: z.string(),
      force: z.boolean().optional().describe('Hard-delete immediately (unrecoverable). Defaults to false.'),
    },
    async (args) => {
      const result = await deleteMemory(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.archive',
    'Soft-archive a memory entry. Archived entries are hidden from reads but restorable.',
    { scope: z.string(), key: z.string() },
    async (args) => {
      const result = await archiveMemory(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.restore',
    'Restore an archived memory entry back to active.',
    { scope: z.string(), key: z.string() },
    async (args) => {
      const result = await restoreMemory(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.list_archived',
    'List archived (soft-deleted) memory entries for a scope.',
    {
      scope: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const result = await listArchived(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.purge',
    'Permanently delete archived entries older than retention_days (default 30). Unrecoverable.',
    {
      retention_days: z.number().int().min(1).max(365).optional(),
    },
    async (args) => {
      const userId = auth.type === 'service' ? null : (auth.userId ?? null);
      const result = await purgeArchived(db, args, userId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'memory.search',
    'Full-text search across memory entries. Supports owner-level scope wildcards (repo::owner/*).',
    {
      q: z.string().describe('Full-text query'),
      scopes: z.array(z.string()).optional().describe('Scope filters; supports repo::owner/* wildcard'),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const result = await search(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

export async function handleMcpRequest(
  req: import('http').IncomingMessage & { body?: unknown },
  res: import('http').ServerResponse,
  auth: AuthContext,
  parsedBody?: unknown,
): Promise<void> {
  // Per-user request rate limit — applied before dispatch, all MCP methods.
  // Service-role (CI/internal) is exempt.
  if (auth.type !== 'service' && auth.userId) {
    const db = getDb(auth);
    const { allowed, retryAfterSeconds } = await checkRateLimit(db, auth.userId);
    if (!allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32029, message: rateLimitMessage(retryAfterSeconds) },
        }),
      );
      return;
    }
  }

  const server = createMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
