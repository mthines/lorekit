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
 * THE ONE EXCEPTION, added with OAuth support (00095_oauth.sql): a request that
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
const edge = (f: string) => readFileSync(path.resolve(here, '../../../../supabase/functions/mcp/', f), 'utf8');
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
    // write-missing, read-missing, key-scope-denied, and
    // account-wide-sweep-on-a-scoped-key (00068).
    //
    // Was 5. The removed one was the `org.*` JWT-only refusal: those tools now
    // go through the same read/write permission gate as the memory family, so
    // the denial they used to hit is one of the two above rather than a fifth
    // of its own. Bumped with the reason named, never loosened.
    //
    // Pinned deliberately: a new denial must be a conscious edit here, because
    // the failure mode this guard exists for is a denial added as -32001, which
    // hangs the client instead of surfacing.
    expect(forbidden.length).toBe(4);
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

// The MCP method guard is NOT asserted in this file. Its whole contract —
// the guard lives in `index.ts`, answers 405 + `Allow: POST`, sits ahead of
// `resolveAuth` and the plan/rate-limit lookups, stays inside `traceRequest`,
// uses `clientError`, leaves no second copy in `handleMcp`, and is reached
// before `handleMcp` so `req.json()` is unreachable for a non-POST — lives in
// `mcp-method-guard-ordering.spec.ts`.
//
// It was briefly asserted in both files. Splitting it did not help: every
// statement about the guard has its subject in `index.ts`, so the assertions
// left behind here read only `mcp-handler.ts` and passed with the guard
// deleted outright. A claim of the form "X is unreachable because of a guard
// in Y" cannot be pinned without reading Y, so it belongs in the one spec that
// reads both.

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

  it('answers the RFC 9728 protected-resource path instead of 404ing it', () => {
    // The document itself is served by the dashboard (both discovery documents
    // live there), but a client that DERIVES this URL from the resource
    // identifier must still land somewhere — a 404 here is a dead end the
    // Authorize button fails silently on. The redirect target and the
    // challenge are cross-checked in oauth-discovery.spec.ts.
    expect(index).toMatch(/isProtectedResourceMetadataPath\(url\.pathname\)/);
    expect(index).toMatch(/protectedResourceMetadataRedirect\(\)/);
  });
});
