/**
 * Pure token extraction for the LoreKit MCP auth layer.
 *
 * Resolves the raw token string from an incoming request, checking in
 * priority order:
 *   1. `Authorization: Bearer <token>` header  — preferred; keeps the token
 *      out of server logs and browser history.
 *   2. `?token=<token>` query parameter          — legacy fallback for MCP
 *      clients that cannot inject custom request headers.
 *
 * Returns null when neither source supplies a non-empty value.
 *
 * This module is import-free so it can be mirrored verbatim into the Deno
 * edge function (`supabase/functions/mcp/auth-token.ts`) and kept in sync by
 * `edge-parity.spec.ts` in `packages/mcp-core`.
 */

export function extractToken(
  authHeader: string | null | undefined,
  queryToken: string | null | undefined,
): string | null {
  if (authHeader) {
    const prefix = 'Bearer ';
    if (authHeader.startsWith(prefix)) {
      const token = authHeader.slice(prefix.length).trim();
      if (token) return token;
    }
  }
  const q = queryToken?.trim();
  if (q) return q;
  return null;
}
