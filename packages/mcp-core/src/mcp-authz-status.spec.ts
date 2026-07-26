import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: post-authentication AUTHORIZATION denials in the edge tools/call
 * path must NOT answer HTTP 401.
 *
 * Regression for the org.* hang: a valid api_key caller hitting an authz limit
 * (org.* requires JWT; read-only / write-only token) used to be rejected with
 * JSON-RPC code -32001, which jsonrpcError maps to HTTP 401. Over the
 * streamable-HTTP transport a 401 on a tools/call is read by mcp-remote as a
 * *session* auth failure — it silently retries/reconnects and the caller's
 * tool-call promise never resolves, so the client hangs (observed ~30 min).
 *
 * An authorization denial is an in-band response to an accepted call and must
 * travel as HTTP 200 with the error in the body (JSONRPC_FORBIDDEN). Only a
 * genuinely unauthenticated request (-32001, pre-dispatch, null id) may be 401.
 *
 * This scans the edge `mcp-handler.ts` source (not mcp-core) because the Deno
 * edge function can't be imported under vitest — same approach as
 * tenant-scope-usage.spec.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const handlerPath = path.resolve(here, '../../../supabase/functions/mcp/mcp-handler.ts');
const source = readFileSync(handlerPath, 'utf8');

/** Slice the body of the `if (method === 'tools/call')` block by brace-depth. */
function extractToolsCallBlock(src: string): string {
  const marker = src.indexOf("method === 'tools/call'");
  if (marker === -1) throw new Error("tools/call branch not found in mcp-handler.ts");
  const bodyStart = src.indexOf('{', marker);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  throw new Error('could not find end of tools/call block');
}

describe('mcp-handler authz status guard', () => {
  it('maps only the unauthenticated code (-32001) to HTTP 401', () => {
    // The 401 branch exists (drives OAuth retry) and is keyed on -32001 alone.
    expect(source).toMatch(/code === -32001 \? 401/);
  });

  it('defines a distinct authorization-denied code mapped to HTTP 200', () => {
    expect(source).toMatch(/const JSONRPC_FORBIDDEN = -32003;/);
    // The status expression must send JSONRPC_FORBIDDEN to 200, not 400/401.
    expect(source).toMatch(/code === JSONRPC_FORBIDDEN \? 200/);
  });

  it('returns JSONRPC_FORBIDDEN (not -32001) for every authz denial in tools/call', () => {
    const block = extractToolsCallBlock(source);

    // The three post-auth authorization denials: org.* JWT requirement,
    // write-permission-missing, read-permission-missing.
    const forbiddenReturns = block.match(/jsonrpcError\(\s*id,\s*JSONRPC_FORBIDDEN/g) ?? [];
    expect(forbiddenReturns.length).toBe(3);

    // No authorization denial may fall back to the 401 code: no jsonrpcError
    // call site in the tools/call block may pass -32001. (Comments referencing
    // -32001 are fine — this targets actual return sites, not documentation.)
    expect(block).not.toMatch(/jsonrpcError\(\s*id,\s*-32001/);
  });
});
