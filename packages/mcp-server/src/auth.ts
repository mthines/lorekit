/**
 * Auth middleware for the LoreKit MCP server.
 * Validates Supabase JWTs and detects service-role tokens for CI use.
 * Unauthenticated requests receive JSON-RPC error -32001 + HTTP 401.
 */
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

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

  // Service-role token check (exact match against the configured key)
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    return { type: 'service' };
  }

  // User JWT — validate via Supabase Auth
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    logger.error('SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    return null;
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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
 * Build a JSON-RPC 2.0 Unauthorized error response.
 * Used when auth fails on the /mcp endpoint.
 */
export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized' },
    }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
