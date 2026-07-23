/**
 * MCP JSON-RPC dispatcher.
 * Handles initialize, tools/list, and tools/call.
 */

import { type AuthContext, getDb, canWrite, getUserId } from './auth.ts';
import { toolWrite, toolRead, toolList, toolDelete, toolSearch, type Params } from './tools.ts';
import { type Span } from '../_shared/otel.ts';

const TOOLS = {
  'memory.write': toolWrite,
  'memory.read': toolRead,
  'memory.list': toolList,
  'memory.delete': toolDelete,
  'memory.search': toolSearch,
} as const;

const WRITE_TOOLS = new Set(['memory.write', 'memory.delete']);

function jsonrpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonrpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { status: code === -32001 ? 401 : 400, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleMcp(req: Request, auth: AuthContext, span: Span): Promise<Response> {
  let body: { id?: unknown; method?: string; params?: Params };
  try {
    body = await req.json();
  } catch {
    return jsonrpcError(null, -32700, 'Parse error');
  }

  const { id = null, method, params = {} } = body;

  if (method === 'initialize') {
    return jsonrpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lorekit', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204 });
  }

  if (method === 'tools/list') {
    return jsonrpc(id, {
      tools: [
        { name: 'memory.write',  description: 'Store or update a lesson',         inputSchema: { type: 'object', required: ['scope', 'key', 'value'] } },
        { name: 'memory.read',   description: 'Read a lesson by scope and key',    inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.list',   description: 'List lessons for a scope',          inputSchema: { type: 'object', required: ['scope'] } },
        { name: 'memory.delete', description: 'Delete a lesson',                   inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.search', description: 'Full-text search across lessons',   inputSchema: { type: 'object', required: ['q'] } },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params.name as keyof typeof TOOLS;
    const toolArgs = params.arguments ?? {};
    const tool = TOOLS[toolName];
    if (!tool) return jsonrpcError(id, -32601, `Unknown tool: ${toolName}`);

    if (WRITE_TOOLS.has(toolName) && !canWrite(auth)) {
      return jsonrpcError(id, -32001, 'This token is read-only. Generate a read+write token in LoreKit.');
    }

    // Create a child span for the tool call
    const rawScope = toolArgs['scope'] as string | undefined;
    const scopeType = rawScope
      ? (rawScope.split('::')[0] ?? 'unknown')
      : 'unknown';
    const toolSpan = span.child(`lorekit.${toolName}`, {
      'lorekit.tool.name': toolName,
      'lorekit.scope.type': scopeType,
      ...(rawScope ? { 'lorekit.scope': rawScope } : {}),
    });

    try {
      const db = getDb(auth);
      const userId = getUserId(auth);
      const result = await tool(db, toolArgs, userId, toolSpan);
      toolSpan.end();
      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      toolSpan.error(`${(err as Error).name}: ${(err as Error).message}`).end();
      return jsonrpcError(id, -32603, (err as Error).message);
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}
