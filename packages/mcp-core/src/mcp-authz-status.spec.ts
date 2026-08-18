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

  it('uses clientError() (not error()) for every authz denial in tools/call so spans are not marked ERROR', () => {
    // Authz denials are client-caused — the server handled them correctly.
    // OTel semantic conventions: server spans are ERROR only for 5xx / server-side faults.
    const block = blockAfter(handler, "method === 'tools/call'", 'tools/call block');
    const clientErrors = block.match(/\.clientError\(/g) ?? [];
    // org.* JWT denial + write-missing + read-missing + unknown-tool = 4 clientError calls
    // (the error-path catch uses clientError only for UserInputError/OrgPermissionError, covered separately)
    expect(clientErrors.length).toBeGreaterThanOrEqual(3);
    // The authz-denial checks all run BEFORE the tool-dispatch try/catch.
    // Slice the block up to the first `try {` that wraps the actual tool call
    // and assert that no bare span.error( appears in that pre-dispatch section
    // (the catch block legitimately uses span.error() for real server faults).
    const preTry = block.slice(0, block.indexOf('\n    try {'));
    const bareErrors = preTry.match(/\bspan\b[^;]*\.error\(/g) ?? [];
    expect(bareErrors.length).toBe(0);
  });
});

describe('mcp GET guard — the no-hang consequence only', () => {
  // SCOPE. The method guard's placement contract — guard lives in `index.ts`,
  // 405 + `Allow: POST`, ahead of `resolveAuth` and the plan/rate-limit
  // lookups, inside `traceRequest`, `clientError` not `error`, no second copy
  // in `handleMcp` — is owned by `mcp-method-guard-ordering.spec.ts`. It was
  // duplicated here and two files pinning one contract drift, so the copy is
  // gone.
  //
  // What stays is the half that belongs to THIS file's subject (auth-family
  // responses must never hang a streamable-HTTP client): a non-POST must never
  // reach `req.json()`, whose "Unexpected end of JSON input" surfaces as a
  // misleading 400 instead of a 405. That is a consequence of the ordering
  // contract, not a restatement of it — it asserts on `mcp-handler.ts`, which
  // the ordering spec's placement assertions do not.
  it('leaves req.json() unreachable for a non-POST, so no bare GET can produce a parse-error 400', () => {
    // `handleMcp` owns the only `req.json()` and runs after auth, which runs
    // after the guard — so a non-POST is answered before it ever gets here.
    expect(handler).toMatch(/body = await req\.json\(\)/);
    // Not re-asserted as a placement check: if the guard were still in the
    // handler, the request would reach the handler and this file's premise
    // (the request is answered before auth) would be false.
    expect(handler).not.toMatch(/req\.method !== 'POST'/);
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
