/**
 * LoreKit MCP Edge Function
 *
 * Self-contained Deno function — no cross-package imports.
 * OTel via _shared/otel.ts: traceRequest() root span, createTracedClient()
 * for automatic Postgres child spans, EdgeRuntime.waitUntil batch flush.
 *
 * Secrets required (supabase secrets set):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GITHUB_WEBHOOK_SECRET
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.us-east-1.aws.dash0.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { traceRequest, createTracedClient, type Span, type TracedSupabaseClient } from '../_shared/otel.ts';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
const MAX_VALUE_BYTES = 65_536;

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
  if (!VALID_PREFIXES.includes(prefix)) throw new Error(`Invalid scope prefix "${prefix}"`);
  return normalized;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

interface AuthContext {
  type: 'user' | 'service';
  jwt?: string;
}

async function resolveAuth(authHeader: string | null, span: Span): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    span.setAttributes({ 'auth.type': 'service' });
    return { type: 'service' };
  }

  const authSpan = span.child('supabase.auth.getUser', { 'auth.type': 'user' });
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    authSpan.error(`AuthError: ${error?.message ?? 'no user'}`).end();
    return null;
  }
  authSpan.setAttributes({ 'auth.user_id': data.user.id }).end();
  span.setAttributes({ 'auth.type': 'user', 'auth.user_id': data.user.id });
  return { type: 'user', jwt: token };
}

function getDb(auth: AuthContext): ReturnType<typeof createClient> {
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

// ── Tool handlers (all accept TracedSupabaseClient) ───────────────────────────

// deno-lint-ignore no-explicit-any
type Params = Record<string, any>;

async function toolWrite(db: TracedSupabaseClient, params: Params) {
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

async function toolRead(db: TracedSupabaseClient, params: Params) {
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

async function toolList(db: TracedSupabaseClient, params: Params) {
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

async function toolDelete(db: TracedSupabaseClient, params: Params) {
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

async function toolSearch(db: TracedSupabaseClient, params: Params) {
  const { q, scopes, tags, limit = 20 } = params;
  if (!q) throw new Error('q is required');
  let query = db
    .from('memories')
    .select('key,value,scope,tags')
    .textSearch('fts', q, { type: 'websearch', config: 'english' })
    .limit(Math.min(limit, 100));
  if (tags?.length) query = query.overlaps('tags', tags);
  if (scopes?.length) {
    const exact: string[] = [];
    const like: string[] = [];
    for (const s of scopes) {
      if (s.endsWith('/*') || s.endsWith('::*')) like.push(s.replace(/\*$/, '%'));
      else { try { exact.push(validateScope(s)); } catch { /* skip */ } }
    }
    const or: string[] = [];
    if (exact.length) or.push(`scope.in.(${exact.map((s) => `"${s}"`).join(',')})`);
    like.forEach((p) => or.push(`scope.like.${p}`));
    if (or.length) query = query.or(or.join(','));
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return { entries: (data ?? []).map((row, i) => ({ ...row, rank: 1 - i * 0.05 })) };
}

const TOOLS = {
  'memory.write': toolWrite,
  'memory.read': toolRead,
  'memory.list': toolList,
  'memory.delete': toolDelete,
  'memory.search': toolSearch,
} as const;

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

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

// ── MCP dispatcher ────────────────────────────────────────────────────────────

async function handleMcp(req: Request, auth: AuthContext, span: Span): Promise<Response> {
  let body: { id?: unknown; method?: string; params?: Params };
  try { body = await req.json(); }
  catch { return jsonrpcError(null, -32700, 'Parse error'); }

  const { id = null, method, params = {} } = body;

  if (method === 'initialize') {
    return jsonrpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lorekit', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 204 });

  if (method === 'tools/list') {
    return jsonrpc(id, {
      tools: [
        { name: 'memory.write',  description: 'Store or update a lesson',          inputSchema: { type: 'object', required: ['scope', 'key', 'value'] } },
        { name: 'memory.read',   description: 'Read a lesson by scope and key',     inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.list',   description: 'List lessons for a scope',           inputSchema: { type: 'object', required: ['scope'] } },
        { name: 'memory.delete', description: 'Delete a lesson',                    inputSchema: { type: 'object', required: ['scope', 'key'] } },
        { name: 'memory.search', description: 'Full-text search across lessons',    inputSchema: { type: 'object', required: ['q'] } },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params.name as keyof typeof TOOLS;
    const toolArgs = params.arguments ?? {};
    const tool = TOOLS[toolName];
    if (!tool) return jsonrpcError(id, -32601, `Unknown tool: ${toolName}`);

    // Create a tool-level child span — its own DB calls will be grandchildren
    const toolSpan = span.child(`lorekit.${toolName}`, {
      'lorekit.tool.name': toolName,
      ...(toolArgs['scope'] ? { 'lorekit.scope': String(toolArgs['scope']), 'lorekit.scope.type': String(toolArgs['scope']).split('::')[0] } : {}),
      ...(toolArgs['key'] ? { 'lorekit.key': String(toolArgs['key']) } : {}),
    });

    try {
      const db = createTracedClient(getDb(auth), toolSpan);
      const result = await tool(db, toolArgs);
      toolSpan.end();
      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      toolSpan.error(`${(err as Error).name}: ${(err as Error).message}`).end();
      return jsonrpcError(id, -32603, (err as Error).message);
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// ── GitHub webhook ────────────────────────────────────────────────────────────

async function verifyHmac(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = `sha256=${hex}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleWebhook(req: Request, span: Span): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');
  const body = await req.text();

  span.setAttributes({ 'lorekit.webhook.event': event });

  if (!await verifyHmac(body, signature)) {
    span.error('HmacError: signature mismatch');
    return new Response('Unauthorized', { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  const payload = JSON.parse(body) as Record<string, any>;
  const action = payload['action'] ?? 'unknown';
  const repo = payload['repository']?.full_name;
  span.setAttributes({ 'lorekit.webhook.action': action, ...(repo ? { 'lorekit.scope': `repo::${repo}` } : {}) });

  if (!repo) return new Response('OK', { status: 200 });

  let commentBody: string | undefined;
  let commentUrl: string | undefined;
  if (event === 'pull_request_review_comment') { commentBody = payload['comment']?.body; commentUrl = payload['comment']?.html_url; }
  else if (event === 'pull_request_review') { commentBody = payload['review']?.body; commentUrl = payload['review']?.html_url; }
  if (!commentBody?.trim()) return new Response('OK', { status: 200 });

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const tracedDb = createTracedClient(db, span);

  try {
    const scope = validateScope(`repo::${repo}`);
    await tracedDb
      .from('memories')
      .upsert({
        scope,
        key: `pr-webhook::${repo}::${Date.now()}`,
        value: commentBody.trim(),
        tags: ['source::pr-webhook', `event::${event}`, `action::${action}`, ...(commentUrl ? [`url::${commentUrl}`] : [])],
        source_agent: 'github-webhook',
        trigger: `${event}.${action}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,scope,key' });
  } catch (err) {
    span.error(`${(err as Error).name}: ${(err as Error).message}`);
    console.error('webhook write failed:', (err as Error).message);
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
    return traceRequest(req, 'lorekit.webhook.github', (span) => handleWebhook(req, span));
  }

  // MCP endpoint — auth then dispatch
  return traceRequest(req, 'lorekit.mcp', async (span) => {
    const auth = await resolveAuth(req.headers.get('authorization'), span);
    if (!auth) return jsonrpcError(null, -32001, 'Unauthorized');
    return handleMcp(req, auth, span);
  });
});
