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
  createUserClient,
  createServiceClient,
} from '@lorekit/core';
import { type AuthContext } from './auth.js';
import { logger } from './logger.js';

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
      const result = await write(db, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
    'Delete a memory entry by scope and key.',
    { scope: z.string(), key: z.string() },
    async (args) => {
      const result = await deleteMemory(db, args);
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

export async function handleMcpRequest(req: Request, auth: AuthContext): Promise<Response> {
  const server = createMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const response = await transport.handleRequest(req);
  return response ?? new Response('', { status: 204 });
}
