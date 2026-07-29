/**
 * MCP JSON-RPC dispatcher.
 * Handles initialize, tools/list, and tools/call.
 */

import { type AuthContext, getDb, canWrite, canRead, getUserId, isJwtAuth } from './auth.ts';
import { type StorageAdapter } from './storage-adapter.ts';
import { UserInputError } from '../_shared/scope.ts';
import { OrgPermissionError } from './org-permissions.ts';
import {
  toolWrite,
  toolRead,
  toolList,
  toolDelete,
  toolSearch,
  toolArchive,
  toolListArchived,
  toolRestore,
  toolPurge,
  toolPurgeExpired,
  toolOrgCreate,
  toolOrgList,
  toolOrgRename,
  toolOrgDelete,
  PURGE_RETENTION_DAYS_DEFAULT,
  type Params,
} from './tools.ts';
import { type Span } from '../_shared/otel.ts';
import { LimitError, recordUsageEvent, getUserPlanName } from './limits.ts';
import { toolRequires } from './permissions.ts';

// memory.* tools — dispatched with (db, args, userId, span)
const MEMORY_TOOLS = {
  'memory.write':         toolWrite,
  'memory.read':          toolRead,
  'memory.list':          toolList,
  'memory.delete':        toolDelete,
  'memory.search':        toolSearch,
  'memory.archive':       toolArchive,
  'memory.list_archived': toolListArchived,
  'memory.restore':       toolRestore,
  'memory.purge':         toolPurge,
  'memory.purge_expired':  toolPurgeExpired,
} as const;

// org.* tools — dispatched with (db, args, span). They require JWT auth
// (auth.uid() inside the SECURITY DEFINER RPCs); api_key callers are rejected
// before dispatch (see the tools/call branch below).
const ORG_TOOLS = {
  'org.create': toolOrgCreate,
  'org.list':   toolOrgList,
  'org.rename': toolOrgRename,
  'org.delete': toolOrgDelete,
} as const;

// All known tool names — used only for the unknown-tool guard in tools/call.
const ALL_TOOL_NAMES = new Set<string>([...Object.keys(MEMORY_TOOLS), ...Object.keys(ORG_TOOLS)]);

function jsonrpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * JSON-RPC error code for an *authenticated* caller that lacks permission for a
 * specific tool — an authorization failure, NOT an authentication failure.
 * Distinct from the Unauthorized code (-32001) so the two are legible in logs,
 * but both are auth-family errors delivered in-band (see jsonrpcError).
 */
const JSONRPC_FORBIDDEN = -32003;

export function jsonrpcError(id: unknown, code: number, message: string): Response {
  // This is a token-based MCP server (no OAuth), so a 401 buys nothing but a
  // hang: streamable-HTTP clients (mcp-remote) read a 401 on the MCP endpoint as
  // a *session* auth failure and silently retry/reconnect, so the caller's
  // promise never resolves. Deliver every auth-family error IN-BAND at HTTP 200
  // instead — the client parses the JSON-RPC error and surfaces it immediately:
  //   -32001          unauthenticated (missing / invalid / rotated token)
  //   JSONRPC_FORBIDDEN authenticated but not permitted (org.* JWT, token scope)
  // Malformed / internal errors stay 400 (a bad request, not an auth signal).
  // Nothing returns 401 — a fast, legible error always beats a hang.
  const status = code === -32001 || code === JSONRPC_FORBIDDEN ? 200 : 400;
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleMcp(req: Request, auth: AuthContext, span: Span, adapter: StorageAdapter): Promise<Response> {
  // POST-only (protocol 2024-11-05). Modern mcp-remote clients probe for SSE
  // support with GET; answer 405 before req.json() to avoid the misleading
  // "Unexpected end of JSON input" parse error. Client probe — use clientError().
  if (req.method !== 'POST') {
    span.clientError(`MethodNotAllowed: ${req.method} is not supported; use POST`).setAttributes({
      'mcp.method': 'unknown',
    });
    return new Response(
      JSON.stringify({ error: 'Method Not Allowed. This MCP server uses POST (protocol 2024-11-05). GET/SSE is not supported.' }),
      {
        status: 405,
        headers: { 'Content-Type': 'application/json', Allow: 'POST' },
      },
    );
  }

  let body: { id?: unknown; method?: string; params?: Params };
  try {
    body = await req.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Client sent malformed JSON — not a server fault. Use clientError() so the
    // span is not marked ERROR (OTel: server spans are ERROR only for 5xx faults).
    span.clientError(`ParseError: invalid JSON body — ${detail}`).setAttributes({ 'mcp.method': 'unknown' });
    return jsonrpcError(null, -32700, `Parse error: ${detail}`);
  }

  const { id = null, method, params = {} } = body;

  span.setAttributes({ 'mcp.method': method ?? 'unknown' });

  if (method === 'initialize') {
    span.setAttributes({ 'mcp.protocol_version': '2024-11-05' });
    return jsonrpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lorekit', version: '1.1.0' },
    });
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204 });
  }

  if (method === 'tools/list') {
    return jsonrpc(id, {
      tools: [
        // ── memory.* ───────────────────────────────────────────────────────
        {
          name: 'memory.write',
          description: 'Store or update a lesson',
          inputSchema: {
            type: 'object',
            required: ['scope', 'key', 'value'],
            properties: {
              scope: { type: 'string' },
              key: { type: 'string' },
              value: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              source_agent: { type: 'string' },
              trigger: { type: 'string' },
              created_at: {
                type: 'string',
                format: 'date-time',
                description:
                  'Optional ISO 8601 creation date. Use when migrating a pre-existing memory so it is dated by its original time instead of now. Rejected if invalid or in the future. Applies only when the memory is first created.',
              },
              org: {
                type: 'string',
                description:
                  'Org slug to write under (org-owned write). Omit for a personal memory. You must be a write-capable member (member/admin/owner, not viewer) of the org, verified server-side — supplying an org slug you are not authorized for is rejected.',
              },
              ttl_days: {
                type: 'integer',
                minimum: 1,
                maximum: 365,
                description:
                  'Number of days until the memory auto-expires. Omit for a permanent memory. On an update, supplying ttl_days refreshes the expiry; omitting it leaves the existing expiry unchanged.',
              },
              clear_ttl: {
                type: 'boolean',
                description:
                  'When true, removes the existing expiry and makes the memory permanent again. Takes precedence over ttl_days when both are supplied.',
              },
            },
          },
        },
        {
          name: 'memory.read',
          description: 'Read a lesson by scope and key',
          inputSchema: { type: 'object', required: ['scope', 'key'] },
        },
        {
          name: 'memory.list',
          description: 'List lessons for a scope',
          inputSchema: { type: 'object', required: ['scope'] },
        },
        {
          name: 'memory.delete',
          description: 'Soft-archive a lesson (default) or hard-delete it (force: true). Archived lessons are hidden from reads but can be restored.',
          inputSchema: {
            type: 'object',
            required: ['scope', 'key'],
            properties: {
              scope: { type: 'string' },
              key: { type: 'string' },
              force: { type: 'boolean', description: 'Hard-delete immediately (unrecoverable). Defaults to false (soft-archive).' },
              org: {
                type: 'string',
                description:
                  'Org slug to delete under (org-owned delete). Omit for a personal memory. Soft-archive requires a member/admin/owner role; hard-delete (force: true) requires admin/owner — verified server-side.',
              },
            },
          },
        },
        {
          name: 'memory.search',
          description: 'Full-text search across lessons',
          inputSchema: { type: 'object', required: ['q'] },
        },
        {
          name: 'memory.archive',
          description: 'Soft-archive a lesson. Archived lessons are hidden from reads but can be restored via memory.restore.',
          inputSchema: { type: 'object', required: ['scope', 'key'] },
        },
        {
          name: 'memory.list_archived',
          description: 'List archived (soft-deleted) lessons for a scope',
          inputSchema: { type: 'object', required: ['scope'] },
        },
        {
          name: 'memory.restore',
          description: 'Restore an archived lesson back to active',
          inputSchema: { type: 'object', required: ['scope', 'key'] },
        },
        {
          name: 'memory.purge',
          description: `Permanently delete archived lessons older than retention_days (default ${PURGE_RETENTION_DAYS_DEFAULT}). Unrecoverable.`,
          inputSchema: {
            type: 'object',
            properties: {
              retention_days: { type: 'integer', minimum: 1, maximum: 365, default: PURGE_RETENTION_DAYS_DEFAULT },
            },
          },
        },
        {
          name: 'memory.purge_expired',
          description: 'Permanently delete all TTL-expired memories for the current user. Unrecoverable.',
          inputSchema: { type: 'object', properties: {} },
        },
        // ── org.* ──────────────────────────────────────────────────────────
        // Require a Supabase user JWT (auth.uid() resolved inside SECURITY
        // DEFINER RPCs). api_key callers are rejected at dispatch with
        // JSONRPC_FORBIDDEN (-32003, HTTP 200) — see the tools/call branch.
        {
          name: 'org.create',
          description:
            'Create a new organization. You become its owner automatically. ' +
            'The slug must be globally unique and lowercase.',
          inputSchema: {
            type: 'object',
            required: ['slug', 'name'],
            properties: {
              slug: { type: 'string', description: 'Unique lowercase org identifier, e.g. "my-team"' },
              name: { type: 'string', description: 'Human-readable display name' },
            },
          },
        },
        {
          name: 'org.list',
          description: 'List all organizations you are a member of, with your role in each.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'org.rename',
          description: 'Rename an organization\'s display name. Requires admin or owner role.',
          inputSchema: {
            type: 'object',
            required: ['slug', 'name'],
            properties: {
              slug: { type: 'string', description: 'The org slug to update' },
              name: { type: 'string', description: 'New display name' },
            },
          },
        },
        {
          name: 'org.delete',
          description:
            'Delete an organization. Requires owner role. ' +
            'Soft-deletes the org — all org lore is immediately hidden from reads. Unrecoverable via MCP.',
          inputSchema: {
            type: 'object',
            required: ['slug'],
            properties: {
              slug: { type: 'string', description: 'The org slug to delete' },
            },
          },
        },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params.name as string;
    const toolArgs = params.arguments ?? {};

    if (!ALL_TOOL_NAMES.has(toolName)) {
      // Client requested a non-existent tool — not a server fault.
      span.clientError(`UnknownTool: ${toolName}`).setAttributes({ 'mcp.tool.name': toolName ?? 'unknown' });
      return jsonrpcError(id, -32601, `Unknown tool: ${toolName}`);
    }

    span.setAttributes({ 'mcp.tool.name': toolName });

    const isOrgTool = toolName in ORG_TOOLS;

    if (isOrgTool) {
      // org.* tools require a Supabase user JWT so auth.uid() resolves inside
      // the SECURITY DEFINER RPCs. Reject api_key and service callers.
      // This is an AUTHORIZATION denial (the caller authenticated fine) → it
      // must be JSONRPC_FORBIDDEN (HTTP 200), never -32001 (HTTP 401), or the
      // MCP client hangs. See jsonrpcError().
      if (!isJwtAuth(auth)) {
        // Authorization denial — the caller authenticated but lacks the right
        // auth type. Not a server fault; use clientError() so the span is not
        // marked ERROR (OTel: server spans are ERROR only for 5xx faults).
        span
          .clientError('PermissionDenied: org.* requires JWT auth')
          .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'jwt_required' });
        return jsonrpcError(
          id,
          JSONRPC_FORBIDDEN,
          'org.* tools require Supabase JWT authentication. ' +
            'They are not available via API token — connect via the dashboard or a Supabase user session.',
        );
      }
    } else {
      // memory.* permission check (api_key auth only; JWT auth is RLS-gated).
      // Authenticated-but-insufficient-scope → JSONRPC_FORBIDDEN (HTTP 200).
      const requiredPermission = toolRequires(toolName as keyof typeof MEMORY_TOOLS);
      if (requiredPermission === 'write' && !canWrite(auth)) {
        // Token scope denial — caller authenticated but the token lacks write
        // permission. Not a server fault; use clientError() so the span is not
        // marked ERROR (OTel: server spans are ERROR only for 5xx faults).
        span
          .clientError('PermissionDenied: read-only token')
          .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'write_permission_missing' });
        return jsonrpcError(id, JSONRPC_FORBIDDEN, 'This token does not have write permission. Use a read+write (lk_rw_) or write-only (lk_wo_) token.');
      }
      if (requiredPermission === 'read' && !canRead(auth)) {
        // Token scope denial — caller authenticated but the token lacks read
        // permission. Not a server fault; use clientError() so the span is not
        // marked ERROR (OTel: server spans are ERROR only for 5xx faults).
        span
          .clientError('PermissionDenied: write-only token')
          .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'read_permission_missing' });
        return jsonrpcError(id, JSONRPC_FORBIDDEN, 'This token does not have read permission. Use a read+write (lk_rw_) or read-only (lk_ro_) token.');
      }
    }

    const rawScope = toolArgs['scope'] as string | undefined;
    const scopeType = rawScope
      ? (rawScope.split('::')[0] ?? 'unknown')
      : 'unknown';
    const toolSpan = span.child(`lorekit.${toolName}`, {
      'lorekit.tool.name': toolName,
      'lorekit.scope.type': scopeType,
      ...(rawScope ? { 'lorekit.scope': rawScope } : {}),
    });

    // Hoist db above try/catch so the error path can record usage events
    // without re-calling getDb.
    const db = getDb(auth);
    // toolUserId: null for JWT auth (RLS handles scoping), api_key userId otherwise.
    // analyticsUserId: the resolved user ID for usage-event annotation regardless of auth type.
    const toolUserId = getUserId(auth);
    const analyticsUserId = toolUserId ?? (auth.type === 'user' ? auth.userId : null) ?? null;

    // Resolve plan name for usage-event annotation (fails open — null → 'free').
    // Only resolved for authenticated non-service callers; service-role has no plan.
    const planName = auth.type !== 'service' && analyticsUserId
      ? await getUserPlanName(db, analyticsUserId)
      : null;
    if (planName) toolSpan.setAttributes({ 'lorekit.plan': planName });

    const toolStartMs = Date.now();

    try {
      let result: unknown;

      if (isOrgTool) {
        // org.* tools: (db, args, span) — no userId parameter; auth.uid()
        // is resolved inside the SECURITY DEFINER RPCs from the JWT.
        result = await ORG_TOOLS[toolName as keyof typeof ORG_TOOLS](db, toolArgs, toolSpan);
      } else {
        // memory.* tools: (db, args, toolUserId, span)
        // toolUserId is null for JWT auth — RLS handles scoping on the DB side.
        result = await MEMORY_TOOLS[toolName as keyof typeof MEMORY_TOOLS](
          db, toolArgs, toolUserId, toolSpan,
        );
      }

      const durationMs = Date.now() - toolStartMs;
      toolSpan.setAttributes({ 'lorekit.duration_ms': durationMs });
      toolSpan.end();

      // Record successful usage event (fire-and-forget).
      if (auth.type !== 'service' && analyticsUserId && adapter.supportsHostedBilling) {
        recordUsageEvent(db, {
          userId: analyticsUserId,
          planName,
          toolName,
          scopeType: rawScope ? scopeType : null,
          authType: auth.type as 'api_key' | 'jwt',
          outcome: 'ok',
          durationMs,
        });
      }

      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      const msg = `${(err as Error).name}: ${(err as Error).message}`;
      const durationMs = Date.now() - toolStartMs;
      toolSpan.setAttributes({ 'lorekit.duration_ms': durationMs });

      // UserInputError (bad scope, missing required arg) and OrgPermissionError
      // (insufficient role) are client-caused — the server handled them correctly.
      // Use clientError() so spans are NOT marked ERROR (OTel: server spans are
      // ERROR only for 5xx / server-side faults, not 4xx client errors).
      const isClientError = err instanceof UserInputError || err instanceof OrgPermissionError;
      if (isClientError) {
        toolSpan.clientError(msg).end();
        span.clientError(msg);
      } else {
        toolSpan.error(msg).end();
        span.error(msg);
      }

      // Record failure usage event (fire-and-forget) — distinguishes cap hits
      // from generic errors in plan-sizing analytics.
      if (auth.type !== 'service' && analyticsUserId && adapter.supportsHostedBilling) {
        const outcome = err instanceof LimitError && err.code === 'memory_cap'
          ? 'cap_exceeded'
          : 'error';
        recordUsageEvent(db, {
          userId: analyticsUserId,
          planName: null,  // skip plan lookup on error path to keep it fast
          toolName,
          scopeType: rawScope ? scopeType : null,
          authType: auth.type as 'api_key' | 'jwt',
          outcome,
          durationMs,
        });
      }

      if (err instanceof LimitError) {
        // Distinct JSON-RPC error code for the memory cap — an actionable,
        // MCP-appropriate error rather than the generic -32603 internal error.
        return jsonrpcError(id, -32040, err.message);
      }
      return jsonrpcError(id, -32603, (err as Error).message);
    }
  }

  // Unknown method — client sent an unsupported JSON-RPC method, not a server fault.
  span.clientError(`MethodNotFound: ${method}`);
  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}
