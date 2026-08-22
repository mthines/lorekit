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
  readFileSync(path.resolve(here, '../../../../supabase/functions/mcp/', f), 'utf8');

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

  it('answers a non-POST before handleMcp, so req.json() is unreachable for one', () => {
    // The reachability consequence of the ordering above, and the original
    // reason the guard exists: `handleMcp` owns the only `req.json()`, whose
    // "Unexpected end of JSON input" surfaces as a misleading 400 instead of a
    // 405. Dispatching it after the guard is what makes that unreachable.
    //
    // Asserted here rather than in `mcp-authz-status.spec.ts`, which used to
    // state it while reading only `mcp-handler.ts` — and therefore still passed
    // with the guard deleted from `index.ts` entirely. The claim needs both
    // sources in scope.
    const guardIdx = index.indexOf("req.method !== 'POST'");
    const dispatchIdx = index.indexOf('handleMcp(req');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(dispatchIdx, 'handleMcp call site not found').toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(dispatchIdx);
    expect(handler).toMatch(/body = await req\.json\(\)/);
  });

  it('still attributes the probe span, without buying the attribution from the database', () => {
    // Skipping `resolveAuth` skips what normally writes `auth.*` onto the
    // request span, which would leave a probe unattributable — the opposite of
    // the visibility this change's own evidence depended on. The guard restores
    // the free half: the credential TIER, decidable from the token string.
    const guardIdx = index.indexOf("req.method !== 'POST'");
    const authIdx = index.indexOf('resolveAuth(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(guardIdx);
    const block = index.slice(guardIdx, authIdx);
    expect(block).toMatch(/'auth\.type': credentialTier\(/);
    // Explicitly 'not_attempted' — an absent attribute is indistinguishable
    // from an auth that ran and found nothing.
    expect(block).toMatch(/'auth\.outcome': 'not_attempted'/);
    // The paid half must stay unbought: no user id, because it lives only in
    // the `api_tokens` row this guard exists to avoid reading. Matched as the
    // quoted ATTRIBUTE KEY, so the surrounding comment may name it in prose.
    expect(block).not.toMatch(/'auth\.user_id'/);
    // And it must not re-derive what the enclosing handler already computed:
    // the guard reads the `url` parsed once at the top and reused by
    // `resolveAuth`. A second parse on the path this change exists to make free
    // is the cost the change is arguing against.
    expect(block).toMatch(/url\.searchParams\.get\('token'\)/);
    // Count the CONSTRUCTOR itself, with no trailing anchor. An earlier version
    // of this assertion required `new URL(req.url);` — the statement form —
    // only so it would not also match the explanatory comment beside the guard.
    // That made it miss the expression form it exists to prevent
    // (`new URL(req.url).searchParams…`, which is literally what this replaced),
    // so a reintroduced second parse still counted one. The comment was reworded
    // instead; the anchor is now chosen against the mutant, not against the prose.
    expect((index.match(/new URL\(req\.url/g) ?? []).length).toBe(1);
  });

  it('derives the guard tier from the same mapping resolveAuthTiers uses', () => {
    // Two independent tier mappings would drift, and the guard's `auth.type`
    // would then disagree with what a POST to the same endpoint reports.
    // `credentialTier` is the single owner: `resolveAuthTiers` branches on it
    // rather than re-testing the token shape itself.
    const auth = edge('auth.ts');
    expect(auth).toMatch(/export function credentialTier\(/);
    expect(auth).toMatch(/const tier = credentialTier\(token\)/);
    expect(auth).toMatch(/if \(tier === 'service'\)/);
    expect(auth).toMatch(/if \(tier === 'api_key'\)/);
    // Exactly one place decides that an `lk_` prefix means the api_key tier.
    expect((auth.match(/startsWith\('lk_'\)/g) ?? []).length).toBe(1);
  });

  it('does not leave a second copy of the guard behind in handleMcp', () => {
    // `handleMcp` has exactly one caller. A duplicate guard would be dead code
    // and a place for the two responses to drift.
    expect(handler).not.toMatch(/req\.method !== 'POST'/);
  });
});
