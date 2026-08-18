import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Ordering guard: the MCP endpoint must reject a non-POST request BEFORE it
 * authenticates.
 *
 * A request's method is knowable from the request line alone — nothing about
 * "GET is not supported here" depends on who is calling. Authenticating first
 * means every SSE-transport probe (`GET /mcp` is the first thing such a client
 * sends) buys a token lookup, a plan lookup and a rate-limit RPC in order to
 * receive a constant 405.
 *
 * Measured over 2026-08-16→17: 75 `mcp.method='unknown'` spans, all `GET /mcp`
 * → 405, at avg 638 ms / max 1983 ms — against 7 ms for an authenticated
 * `tools/list` from the internal service token. The three preamble queries run
 * once per request (`SELECT api_tokens` 149 ms + `RPC lorekit_check_rate_limit`
 * 89 ms + `SELECT user_plans` 81 ms = 319 ms of fixed cost) and all 75 paid it.
 *
 * Scans the Deno edge entrypoint, which vitest cannot import — the same
 * approach as `mcp-authz-status.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f: string) =>
  readFileSync(path.resolve(here, '../../../supabase/functions/mcp/', f), 'utf8');

const index = edge('index.ts');
const handler = edge('mcp-handler.ts');

describe('mcp entrypoint rejects a non-POST before authenticating', () => {
  it('has the method guard in index.ts', () => {
    expect(index).toMatch(/req\.method !== 'POST'/);
    expect(index).toMatch(/status: 405/);
    expect(index).toMatch(/Allow: 'POST'/);
  });

  it('places the guard BEFORE resolveAuth', () => {
    const guardIdx = index.indexOf("req.method !== 'POST'");
    const authIdx = index.indexOf('resolveAuth(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(authIdx);
  });

  it('places the guard BEFORE the plan and rate-limit lookups', () => {
    const guardIdx = index.indexOf("req.method !== 'POST'");
    // Assert presence first — otherwise a missing guard is index -1 and every
    // "comes before" comparison below passes vacuously.
    expect(guardIdx).toBeGreaterThan(-1);
    for (const preamble of ['getUserPlanName(', 'checkRateLimit(']) {
      const idx = index.indexOf(preamble);
      expect(idx, `${preamble} not found`).toBeGreaterThan(-1);
      expect(guardIdx, `guard must precede ${preamble}`).toBeLessThan(idx);
    }
  });

  it('still runs inside traceRequest, so the probe stays visible in telemetry', () => {
    // Moving the guard must not move it OUT of the span. A 405 that produces no
    // span would trade a measurable cost for an invisible one.
    //
    // Match `return traceRequest(` — the CALL — not a bare `traceRequest(`,
    // which also matches the docblock at the top of the file 60 lines above it
    // and would make this assertion pass for a guard hoisted outside the span.
    const traceIdx = index.indexOf('return traceRequest(');
    const guardIdx = index.indexOf("req.method !== 'POST'");
    expect(traceIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(traceIdx).toBeLessThan(guardIdx);

    // Stronger still: the guard must sit inside the callback, so the `span`
    // handed to it is the request span. A guard placed between `traceRequest(`
    // and its callback body could not reference `span` at all.
    const callbackStart = index.indexOf('(span) => {', traceIdx);
    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackStart).toBeLessThan(guardIdx);
  });

  it('marks the probe as a client error, not a server fault', () => {
    // OTel: a server span is ERROR only for 5xx. A client probing for SSE is
    // behaving reasonably against a server that does not offer it.
    // Bound the window at `resolveAuth(` — the guard's own end — rather than a
    // fixed char count. The guard block is 766 chars, so a 900-char window ran
    // 134 chars past `resolveAuth(` and both assertions below could have been
    // satisfied by code outside the guard. `mcp-authz-status.spec.ts` slices the
    // same way.
    const guardIdx = index.indexOf("req.method !== 'POST'");
    const authIdx = index.indexOf('resolveAuth(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(guardIdx);
    const block = index.slice(guardIdx, authIdx);
    expect(block).toMatch(/clientError\(/);
    expect(block).toMatch(/'mcp\.method': 'unknown'/);
  });

  it('does not leave a second copy of the guard behind in handleMcp', () => {
    // `handleMcp` has exactly one caller. A duplicate guard would be dead code
    // and a place for the two responses to drift.
    expect(handler).not.toMatch(/req\.method !== 'POST'/);
  });
});
