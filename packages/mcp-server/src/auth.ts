/**
 * Auth middleware for the LoreKit MCP server.
 * Validates Supabase JWTs and detects service-role tokens for CI use.
 * Unauthenticated requests receive JSON-RPC error -32001 + HTTP 401.
 */
import { createClient } from '@supabase/supabase-js';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { logger } from './logger.js';

const tracer = trace.getTracer('lorekit.mcp-server', '1.0.0');

// Read lazily (not as module-level consts) so tests that set process.env in
// beforeEach — after this module has already been imported — see the value
// they configured, and so a real process picks up env changes without a
// restart-order dependency either way.
function getSupabaseUrl(): string {
  return process.env['SUPABASE_URL'] ?? '';
}
function getSupabaseAnonKey(): string {
  return process.env['SUPABASE_ANON_KEY'] ?? '';
}
function getServiceRoleKey(): string {
  return process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
}

export interface AuthContext {
  type: 'user' | 'service';
  userId?: string;
  jwt?: string;
}

/**
 * Extract and validate the Bearer token from an Authorization header.
 * Returns AuthContext on success, or null if invalid/missing.
 *
 * Every call produces an `lorekit.auth.resolve` span so auth outcomes
 * (missing header, service-role match, JWT validation) are visible in Dash0
 * without digging into logs. The span is INTERNAL (not SERVER) — it is a
 * child of the HTTP server span produced by auto-instrumentation.
 *
 * PII note: user IDs are UUIDs and are safe to attach as span attributes.
 * The raw JWT is never attached.
 */
export async function resolveAuth(authHeader: string | undefined): Promise<AuthContext | null> {
  return tracer.startActiveSpan(
    'lorekit.auth.resolve',
    { kind: SpanKind.INTERNAL },
    async (span) => {
      try {
        return await _resolveAuth(authHeader, span);
      } catch (err) {
        const error = err as Error;
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.setAttribute(ATTR_ERROR_TYPE, error.name);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

async function _resolveAuth(
  authHeader: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  span: any,
): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    span.setAttribute('auth.outcome', 'missing_header');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'missing or malformed Authorization header' });
    return null;
  }

  const token = authHeader.slice(7);
  const serviceRoleKey = getServiceRoleKey();
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  // Service-role token check (exact match against the configured key)
  if (serviceRoleKey && token === serviceRoleKey) {
    span.setAttribute('auth.outcome', 'service_role');
    span.setAttribute('auth.type', 'service');
    return { type: 'service' };
  }

  // User JWT — validate via Supabase Auth
  if (!supabaseUrl || !supabaseAnonKey) {
    logger.error('SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    span.setAttribute('auth.outcome', 'misconfigured');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Supabase env vars missing' });
    return null;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    logger.warn({ error: error?.message }, 'auth.jwt.invalid');
    span.setAttribute('auth.outcome', 'jwt_invalid');
    span.setAttribute('auth.error', error?.message ?? 'no user returned');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'JWT validation failed' });
    return null;
  }

  span.setAttribute('auth.outcome', 'jwt_valid');
  span.setAttribute('auth.type', 'user');
  span.setAttribute('auth.user_id', data.user.id);
  return { type: 'user', userId: data.user.id, jwt: token };
}

/**
 * Write a JSON-RPC 2.0 Unauthorized error to a Node.js ServerResponse.
 */
export function sendUnauthorized(res: import('http').ServerResponse): void {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message: 'Unauthorized' },
  });
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Returns a JSON-RPC 2.0 Unauthorized error as a Web API Response.
 * Useful for environments that work with the Fetch API (tests, edge runtimes).
 * For Node.js HTTP servers use sendUnauthorized() instead.
 */
export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}
