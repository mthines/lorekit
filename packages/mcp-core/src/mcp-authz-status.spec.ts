import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: the edge MCP endpoint must never answer an auth error with HTTP
 * 401, and must never emit an auth error with a null JSON-RPC id.
 *
 * Why: this is a token-based MCP server (no OAuth). A 401 on the MCP endpoint is
 * read by streamable-HTTP clients (mcp-remote) as a *session* auth failure —
 * they silently retry/reconnect and the caller's promise never resolves, so the
 * client hangs (observed ~30 min on org.* with a valid token, and again on a
 * rotated token). A response with id:null can't be correlated to the pending
 * call and hangs the same way. Both auth-family errors must therefore travel
 * IN-BAND: HTTP 200 + a JSON-RPC error carrying the real request id, so the
 * client surfaces "invalid token" / "requires JWT" fast instead of hanging.
 *
 *   -32001            unauthenticated (missing / invalid / rotated token)
 *   JSONRPC_FORBIDDEN authenticated but not permitted (org.* JWT, token scope)
 *
 * These scan the Deno edge sources (which vitest can't import) — same approach
 * as tenant-scope-usage.spec.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f: string) => readFileSync(path.resolve(here, '../../../supabase/functions/mcp/', f), 'utf8');
const handler = edge('mcp-handler.ts');
const index = edge('index.ts');

/** Slice a brace-delimited block starting at the first `{` after `marker`. */
function blockAfter(src: string, marker: string, label: string): string {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error(`${label} not found`);
  const start = src.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`could not find end of ${label}`);
}

describe('mcp-handler auth status guard', () => {
  it('maps both auth-family codes to HTTP 200 and never to 401', () => {
    expect(handler).toMatch(/const JSONRPC_FORBIDDEN = -32003;/);
    expect(handler).toMatch(
      /const status = code === -32001 \|\| code === JSONRPC_FORBIDDEN \? 200 : 400;/,
    );
    // No status branch may yield 401 (comments may mention it; code may not).
    expect(handler).not.toMatch(/[?:]\s*401/);
  });

  it('returns JSONRPC_FORBIDDEN (not -32001) for every authz denial in tools/call', () => {
    const block = blockAfter(handler, "method === 'tools/call'", 'tools/call block');
    const forbidden = block.match(/jsonrpcError\(\s*id,\s*JSONRPC_FORBIDDEN/g) ?? [];
    expect(forbidden.length).toBe(3); // org.* JWT, write-missing, read-missing
    expect(block).not.toMatch(/jsonrpcError\(\s*id,\s*-32001/);
  });
});

describe('index.ts auth-failure guard', () => {
  it('answers a bad/missing token in-band with a real id and HTTP 200, not 401', () => {
    const block = blockAfter(index, 'if (!auth)', 'auth-failure block');
    // Status recorded as 200, never 401.
    expect(block).toMatch(/'http\.response\.status_code': 200/);
    expect(block).not.toMatch(/'http\.response\.status_code': 401/);
    // Echoes the real request id (peeked from the body) — never id:null, which
    // the client can't correlate and would hang on.
    expect(block).toMatch(/peekRequestId/);
    expect(block).toMatch(/jsonrpcError\(\s*reqId,/);
    expect(block).not.toMatch(/jsonrpcError\(\s*null/);
  });
});
