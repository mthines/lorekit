/**
 * Auth middleware for the LoreKit MCP server.
 * Validates Supabase JWTs and detects service-role tokens for CI use.
 * Unauthenticated requests receive JSON-RPC error -32001 + HTTP 401.
 */
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

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
 */
export async function resolveAuth(authHeader: string | undefined): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const serviceRoleKey = getServiceRoleKey();
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  // Service-role token check (exact match against the configured key)
  if (serviceRoleKey && token === serviceRoleKey) {
    return { type: 'service' };
  }

  // User JWT — validate via Supabase Auth
  if (!supabaseUrl || !supabaseAnonKey) {
    logger.error('SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    return null;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    logger.warn({ error: error?.message }, 'auth.jwt.invalid');
    return null;
  }

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
