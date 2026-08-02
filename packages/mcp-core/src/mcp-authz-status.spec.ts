import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: an MCP request that PRESENTED a credential must never be
 * answered with HTTP 401, and no auth error may carry a null JSON-RPC id.
 *
 * Why: a 401 on a *configured* client is read by streamable-HTTP clients
 * (mcp-remote) as a session auth failure — they silently retry/reconnect and
 * the caller's promise never resolves, so the client hangs (observed ~30 min on
 * org.* with a valid token, and again on a rotated token). A response with
 * id:null can't be correlated to the pending call and hangs the same way. Both
 * auth-family errors must therefore travel IN-BAND: HTTP 200 + a JSON-RPC error
 * carrying the real request id, so the client surfaces "invalid token" /
 * "requires JWT" fast instead of hanging.
 *
 *   -32001            unauthenticated (invalid / rotated / expired token)
 *   JSONRPC_FORBIDDEN authenticated but not permitted (org.* JWT, token scope)
 *
 * THE ONE EXCEPTION, added with OAuth support (00049_oauth.sql): a request that
 * presented NO credential at all gets 401 + `WWW-Authenticate` (RFC 9728). That
 * header is the entire OAuth discovery trigger — without it an MCP host's
 * "Authorize" button cannot find our authorization server. The exception cannot
 * reintroduce the hang it replaced: a client with no credential has not been
 * configured yet, so there is no pending, correlated tools/call to stall. The
 * assertions below pin BOTH halves — that the no-credential branch challenges,
 * and that the credential-present branch still answers in-band with 200.
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

describe('mcp-handler GET guard', () => {
  it('intercepts non-POST requests with 405 before trying to parse JSON, using clientError()', () => {
    // GET is used by modern mcp-remote clients probing for SSE support (MCP 2025-03-26 spec).
    // The server implements 2024-11-05 (POST-only). Without this guard, GET hits req.json()
    // which throws "Unexpected end of JSON input" — a misleading 400, not the correct 405.
    // The guard must use clientError() (not error()) so the span is not marked ERROR.
    expect(handler).toMatch(/req\.method !== 'POST'/);
    expect(handler).toMatch(/status: 405/);
    expect(handler).toMatch(/Allow: 'POST'/);
    // The guard must appear BEFORE req.json() — check it's before the try/catch for body parsing
    const getGuardIdx = handler.indexOf("req.method !== 'POST'");
    const jsonParseIdx = handler.indexOf('body = await req.json()');
    expect(getGuardIdx).toBeGreaterThan(-1);
    expect(jsonParseIdx).toBeGreaterThan(-1);
    expect(getGuardIdx).toBeLessThan(jsonParseIdx);
    // Must use clientError() not error() — GET is a client probe, not a server fault
    const guardBlock = handler.slice(getGuardIdx, jsonParseIdx);
    expect(guardBlock).toMatch(/\.clientError\(/);
    expect(guardBlock).not.toMatch(/\.error\(/);
  });
});

describe('index.ts auth-failure guard', () => {
  /**
   * The auth-failure block now has two branches. Split it at the
   * no-credential guard so each half can be asserted for the behaviour that
   * half owns — asserting over the whole block would let either property
   * satisfy the other's test.
   */
  const authBlock = blockAfter(index, 'if (!auth)', 'auth-failure block');
  const challengeStart = authBlock.indexOf('if (!presentedToken)');
  const challengeBranch = blockAfter(authBlock, 'if (!presentedToken)', 'no-credential branch');
  // Everything after the challenge branch closes is the in-band path.
  const inBandBranch = authBlock.slice(challengeStart + challengeBranch.length);

  it('challenges a credential-LESS request with 401 + WWW-Authenticate so OAuth discovery works', () => {
    // The branch must be selected on the ABSENCE of a presented credential —
    // not on the auth result — so a rotated token can never reach it.
    expect(index).toMatch(/const presentedToken = extractToken\(/);
    expect(challengeStart).toBeGreaterThan(-1);
    expect(challengeBranch).toMatch(/status: 401/);
    expect(challengeBranch).toMatch(/'WWW-Authenticate': wwwAuthenticateChallenge\(\)/);
    // Exposed so a browser-based client can actually read the header.
    expect(challengeBranch).toMatch(/'Access-Control-Expose-Headers': 'WWW-Authenticate'/);
  });

  it('still answers a PRESENTED but invalid token in-band with a real id and HTTP 200, not 401', () => {
    // Status recorded as 200, never 401.
    expect(inBandBranch).toMatch(/'http\.response\.status_code': 200/);
    expect(inBandBranch).not.toMatch(/status: 401/);
    // Echoes the real request id (peeked from the body) — never id:null, which
    // the client can't correlate and would hang on.
    expect(authBlock).toMatch(/peekRequestId/);
    expect(authBlock).toMatch(/jsonrpcError\(\s*reqId,/);
    expect(authBlock).not.toMatch(/jsonrpcError\(\s*null/);
  });

  it('serves the RFC 9728 protected-resource document the challenge points at', () => {
    // A challenge naming a document the server does not serve is a dead end:
    // the client fetches it, 404s, and the Authorize button fails silently.
    expect(index).toMatch(/isProtectedResourceMetadataPath\(url\.pathname\)/);
    expect(index).toMatch(/protectedResourceMetadata\(\)/);
  });
});
