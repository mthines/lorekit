/**
 * LoreKit MCP Edge Function
 *
 * Self-contained Deno function — no cross-package imports.
 * Implements the MCP JSON-RPC protocol directly for the five memory tools
 * and the GitHub webhook handler.
 *
 * Secrets required (set via `supabase secrets set`):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GITHUB_WEBHOOK_SECRET
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.us-east-1.aws.dash0.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
const MAX_VALUE_BYTES = 65_536;

// ── OTel — lightweight OTLP/JSON span sender ──────────────────────────────────
// No SDK needed: read env vars, build a minimal OTLP/JSON payload, fire-and-forget.

const OTLP_ENDPOINT = Deno.env.get('OTEL_EXPORTER_OTLP_ENDPOINT');
const OTLP_HEADERS_RAW = Deno.env.get('OTEL_EXPORTER_OTLP_HEADERS') ?? '';

/** Parse "Authorization=Bearer tok,X-Other=val" → { Authorization: "Bearer tok" } */
function parseOtlpHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const idx = pair.indexOf('=');
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
    }),
  );
}

const OTLP_PARSED_HEADERS = parseOtlpHeaders(OTLP_HEADERS_RAW);

/** Random 32-hex-char trace ID */
function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 0);
}
/** Random 16-hex-char span ID */
function newSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

type SpanStatus = 'ok' | 'error';

interface SpanOptions {
  name: string;
  traceId: string;
  startMs: number;
  endMs: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
}

/**
 * Fire-and-forget: send a single OTLP/JSON span to Dash0.
 * Uses `fetch()` — Deno/Edge runtime supports it natively.
 * Errors are swallowed so telemetry failures never affect the MCP response.
 */
function sendSpan(opts: SpanOptions): void {
  if (!OTLP_ENDPOINT) return;

  const spanId = newSpanId();
  const startNs = String(opts.startMs * 1_000_000);
  const endNs = String(opts.endMs * 1_000_000);

  const body = JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'lorekit-mcp' } },
          { key: 'deployment.environment.name', value: { stringValue: 'production' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'lorekit-mcp', version: '1.0.0' },
        spans: [{
          traceId: opts.traceId,
          spanId,
          name: opts.name,
          kind: 1, // INTERNAL
          startTimeUnixNano: startNs,
          endTimeUnixNano: endNs,
          attributes: Object.entries(opts.attributes).map(([key, value]) => ({
            key,
            value: typeof value === 'number'
              ? { intValue: value }
              : typeof value === 'boolean'
                ? { boolValue: value }
                : { stringValue: String(value) },
          })),
          status: {
            code: opts.status === 'error' ? 2 : 1, // ERROR=2, OK=1
            ...(opts.statusMessage ? { message: opts.statusMessage } : {}),
          },
        }],
      }],
    }],
  });

  // Fire-and-forget — never await, never throw
  fetch(`${OTLP_ENDPOINT}/v1/traces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...OTLP_PARSED_HEADERS },
    body,
  }).catch(() => { /* swallow */ });
}

// ── Scope utilities ───────────────────────────────────────────────────────────

type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';
const VALID_PREFIXES: ScopePrefix[] = ['global', 'project', 'repo', 'branch'];

function validateScope(raw: string): string {
  if (!raw) throw new Error('scope must be a non-empty string');
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new Error(`Invalid scope "${raw}": use "::" as the separator, not ":"`);
  }
  const normalized = raw.toLowerCase().trim();
  if (normalized === 'global') return 'global';
  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) throw new Error(`Invalid scope "${raw}": unknown scope type`);
  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  if (!VALID_PREFIXES.includes(prefix)) {
    throw new Error(`Invalid scope prefix "${prefix}"`);
  }
  return normalized;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

interface AuthContext {
  type: 'user' | 'service';
  jwt?: string;
}

async function resolveAuth(authHeader: string | null): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return { type: 'service' };
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { type: 'user', jwt: token };
}

function getDb(auth: AuthContext) {
  if (auth.type === 'service') {
    return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.jwt!}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Params = Record<string, any>;

async function toolWrite(db: ReturnType<typeof createClient>, params: Params) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger } = params;
  if (!rawScope || !key || !value) throw new Error('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  const scope = validateScope(rawScope);
  const { data, error } = await db
    .from('memories')
    .upsert(
      { scope, key, value, tags, source_agent: source_agent ?? null, trigger: trigger ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,scope,key' },
    )
    .select('id,created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function toolRead(db: ReturnType<typeof createClient>, params: Params) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);
  const { data, error } = await db
    .from('memories')
    .select('value,updated_at')
    .eq('scope', scope)
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function toolList(db: ReturnType<typeof createClient>, params: Params) {
  const { scope: rawScope, tags, limit = 50 } = params;
  if (!rawScope) throw new Error('scope is required');
  const scope = validateScope(rawScope);
  let query = db
    .from('memories')
    .select('key,value,tags,updated_at')
    .eq('scope', scope)
    .order('updated_at', { ascending: false })
    .limit(Math.min(limit, 100));
  if (tags?.length) query = query.overlaps('tags', tags);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return { entries: data ?? [] };
}

async function toolDelete(db: ReturnType<typeof createClient>, params: Params) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);
  const { error, count } = await db
    .from('memories')
    .delete({ count: 'exact' })
    .eq('scope', scope)
    .eq('key', key);
  if (error) throw new Error(error.message);
  return { deleted: (count ?? 0) > 0 };
}

async function toolSearch(db: ReturnType<typeof createClient>, params: Params) {
  const { q, scopes, tags, limit = 20 } = params;
  if (!q) throw new Error('q is required');
  let query = db
    .from('memories')
    .select('key,value,scope,tags')
    .textSearch('fts', q, { type: 'websearch', config: 'english' })
    .limit(Math.min(limit, 100));
  if (tags?.length) query = query.overlaps('tags', tags);
  if (scopes?.length) {
    const exactScopes: string[] = [];
    const likePatterns: string[] = [];
    for (const s of scopes) {
      if (s.endsWith('/*') || s.endsWith('::*')) {
        likePatterns.push(s.replace(/\*$/, '%'));
      } else {
        try { exactScopes.push(validateScope(s)); } catch { /* skip invalid */ }
      }
    }
    const orParts: string[] = [];
    if (exactScopes.length) orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
    likePatterns.forEach((p) => orParts.push(`scope.like.${p}`));
    if (orParts.length) query = query.or(orParts.join(','));
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return {
    entries: (data ?? []).map((row, i) => ({ ...row, rank: 1 - i * 0.05 })),
  };
}

// ── MCP JSON-RPC dispatcher ───────────────────────────────────────────────────

const TOOLS = {
  'memory.write': toolWrite,
  'memory.read': toolRead,
  'memory.list': toolList,
  'memory.delete': toolDelete,
  'memory.search': toolSearch,
} as const;

function jsonrpc(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonrpcError(id: unknown, code: number, message: string) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { status: code === -32001 ? 401 : 400, headers: { 'Content-Type': 'application/json' } },
  );
}

async function handleMcp(req: Request, auth: AuthContext): Promise<Response> {
  let body: { id?: unknown; method?: string; params?: Params };
  try {
    body = await req.json();
  } catch {
    return jsonrpcError(null, -32700, 'Parse error');
  }

  const { id = null, method, params = {} } = body;

  // Handle MCP initialize and notifications/initialized (handshake)
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

  // tools/list — return available tools
  if (method === 'tools/list') {
    return jsonrpc(id, {
      tools: [
        { name: 'memory.write', description: 'Store or update a lesson', inputSchema: { type: 'object', required: ['scope', 'key', 'value'] } },
        { name: 'memory.read', description: 'Read a lesson by scope and key', inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.list', description: 'List lessons for a scope', inputSchema: { type: 'object', required: ['scope'] } },
        { name: 'memory.delete', description: 'Delete a lesson', inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.search', description: 'Full-text search across lessons', inputSchema: { type: 'object', required: ['q'] } },
      ],
    });
  }

  // tools/call
  if (method === 'tools/call') {
    const toolName = params.name as keyof typeof TOOLS;
    const toolArgs = params.arguments ?? {};
    const tool = TOOLS[toolName];
    if (!tool) return jsonrpcError(id, -32601, `Unknown tool: ${toolName}`);

    const startMs = Date.now();
    const traceId = newTraceId();
    let status: SpanStatus = 'ok';
    let statusMessage: string | undefined;

    try {
      const db = getDb(auth);
      const result = await tool(db, toolArgs);
      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      status = 'error';
      statusMessage = `${(err as Error).name}: ${(err as Error).message}`;
      return jsonrpcError(id, -32603, (err as Error).message);
    } finally {
      const scopeRaw = (toolArgs as Params)['scope'] as string | undefined;
      sendSpan({
        name: `lorekit.${toolName}`,
        traceId,
        startMs,
        endMs: Date.now(),
        status,
        statusMessage,
        attributes: {
          'lorekit.tool.name': toolName,
          ...(scopeRaw ? { 'lorekit.scope': scopeRaw } : {}),
          ...(scopeRaw ? { 'lorekit.scope.type': scopeRaw.split('::')[0] ?? 'unknown' } : {}),
          ...((toolArgs as Params)['key'] ? { 'lorekit.key': String((toolArgs as Params)['key']) } : {}),
        },
      });
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// ── GitHub webhook ────────────────────────────────────────────────────────────

async function verifyHmac(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = `sha256=${hex}`;
  // Timing-safe compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleWebhook(req: Request): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');
  const body = await req.text();
  const startMs = Date.now();
  const traceId = newTraceId();

  if (!await verifyHmac(body, signature)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  const payload = JSON.parse(body) as Record<string, any>;
  const action = payload['action'] ?? 'unknown';
  const repo = payload['repository']?.full_name;
  if (!repo) return new Response('OK', { status: 200 });

  let commentBody: string | undefined;
  let commentUrl: string | undefined;
  if (event === 'pull_request_review_comment') {
    commentBody = payload['comment']?.body;
    commentUrl = payload['comment']?.html_url;
  } else if (event === 'pull_request_review') {
    commentBody = payload['review']?.body;
    commentUrl = payload['review']?.html_url;
  }

  if (!commentBody?.trim()) return new Response('OK', { status: 200 });

  let status: SpanStatus = 'ok';
  let statusMessage: string | undefined;

  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const scope = validateScope(`repo::${repo}`);
    await toolWrite(db, {
      scope,
      key: `pr-webhook::${repo}::${Date.now()}`,
      value: commentBody.trim(),
      tags: ['source::pr-webhook', `event::${event}`, `action::${action}`, ...(commentUrl ? [`url::${commentUrl}`] : [])],
      source_agent: 'github-webhook',
      trigger: `${event}.${action}`,
    });
  } catch (err) {
    status = 'error';
    statusMessage = `${(err as Error).name}: ${(err as Error).message}`;
    console.error('webhook write failed:', (err as Error).message);
  } finally {
    sendSpan({
      name: 'lorekit.webhook.github',
      traceId,
      startMs,
      endMs: Date.now(),
      status,
      statusMessage,
      attributes: {
        'lorekit.webhook.event': event,
        'lorekit.webhook.action': action,
        'lorekit.scope': `repo::${repo}`,
        'lorekit.scope.type': 'repo',
      },
    });
  }

  return new Response('OK', { status: 200 });
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith('/healthz')) {
    return new Response('ok', { status: 200 });
  }

  if (url.pathname.endsWith('/webhooks/github')) {
    return handleWebhook(req);
  }

  // Default: MCP endpoint
  const auth = await resolveAuth(req.headers.get('authorization'));
  if (!auth) return jsonrpcError(null, -32001, 'Unauthorized');
  return handleMcp(req, auth);
});
