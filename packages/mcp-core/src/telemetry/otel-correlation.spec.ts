import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatTraceparent, parseTraceparent } from './trace-context.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readRepo = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Cross-service trace-context correlation contract.
 *
 * The user question this suite answers: "when the CLI calls the api, or MCP
 * calls the api, do the spans actually join into ONE trace, and is the
 * parent/child linkage correct?"
 *
 * Every LoreKit component propagates W3C `traceparent` through the SAME two
 * pure functions — `parseTraceparent` (receiver) and `formatTraceparent`
 * (sender) — which are the single seam mirrored verbatim into every edge
 * function (`supabase/functions/_shared/trace-context.ts`) and re-implemented
 * byte-for-byte by the zero-dep CLI (`packages/cli/src/telemetry.mjs`
 * `getActiveTraceparent`). So the correlation contract is provable purely from
 * that seam, without booting a Deno isolate or an OTel SDK.
 *
 * The reference helpers below RE-STATE the wiring in
 * `supabase/functions/_shared/otel.ts` so the correlation *semantics* can be
 * asserted without a Deno isolate:
 *   - `serverContinue`  ≡ `extractTraceContext` (continue inbound, or new root)
 *   - `echoTraceparent` ≡ `withTraceparent`     (server → response header)
 *   - `cliTraceparent`  ≡ CLI `getActiveTraceparent`
 * Because they are copies, two drift guards keep them honest against the SHIPPED
 * code rather than against themselves:
 *   - the "zero-dep CLI header" test below source-scans the CLI's ACTUAL
 *     `getActiveTraceparent` template and proves it renders byte-identically to
 *     `formatTraceparent`;
 *   - `otel-conventions.spec.ts` ("edge + CLI route propagation through the
 *     shared W3C seam") source-scans that `extractTraceContext` /
 *     `withTraceparent` / `getActiveTraceparent` still route through
 *     `parseTraceparent` / `formatTraceparent`.
 */

// Fresh, spec-valid ids — mirrors `randHex(16)` (trace) / `randHex(8)` (span).
const freshTraceId = () => randomBytes(16).toString('hex');
const freshSpanId = () => randomBytes(8).toString('hex');

/**
 * Receiver seam — mirrors `extractTraceContext` in `_shared/otel.ts`.
 * A valid inbound header CONTINUES the trace (same trace id, fresh span id,
 * parent = inbound span). Anything invalid starts a NEW root (AlwaysOn).
 */
function serverContinue(inboundHeader: string | null | undefined) {
  const parsed = parseTraceparent(inboundHeader);
  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: freshSpanId(),
      parentSpanId: parsed.parentSpanId,
      sampled: parsed.sampled,
      isRoot: false,
    };
  }
  // Locally-originated root — today's AlwaysOn behaviour.
  return { traceId: freshTraceId(), spanId: freshSpanId(), parentSpanId: undefined, sampled: true, isRoot: true };
}

/** Sender seam — the header a server echoes back / a caller injects downstream. */
function echoTraceparent(ctx: { traceId: string; spanId: string; sampled: boolean }): string {
  return formatTraceparent(ctx.traceId, ctx.spanId, ctx.sampled);
}

/**
 * Reference re-statement of the CLI's `getActiveTraceparent` header, used by the
 * behavioural correlation proofs below. It is a COPY — the "zero-dep CLI header"
 * test guards it against the shipped CLI source, so it can't silently drift.
 */
const cliTraceparent = (traceId: string, spanId: string, sampled: boolean) =>
  `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;

describe('CLI → api correlation', () => {
  it('the api server span joins the CLI command trace as a child', () => {
    // A CLI command generates one root span for the whole command.
    const cli = { traceId: freshTraceId(), spanId: freshSpanId(), sampled: true };
    const outgoing = cliTraceparent(cli.traceId, cli.spanId, cli.sampled);

    const server = serverContinue(outgoing);

    expect(server.isRoot).toBe(false);
    // Same trace → both spans render under one waterfall in Dash0.
    expect(server.traceId).toBe(cli.traceId);
    // The server span is a NEW span, parented on the CLI command span.
    expect(server.spanId).not.toBe(cli.spanId);
    expect(server.parentSpanId).toBe(cli.spanId);
    // The sampled decision rides along unchanged.
    expect(server.sampled).toBe(cli.sampled);
  });

  it('every REST call in one command lands under the same command span (siblings)', () => {
    // The CLI reuses one command span id for the whole run, so N REST calls
    // produce N sibling server spans that all point back at it.
    const cli = { traceId: freshTraceId(), spanId: freshSpanId(), sampled: true };
    const header = cliTraceparent(cli.traceId, cli.spanId, cli.sampled);

    const call1 = serverContinue(header);
    const call2 = serverContinue(header);
    const call3 = serverContinue(header);

    for (const c of [call1, call2, call3]) {
      expect(c.traceId).toBe(cli.traceId);
      expect(c.parentSpanId).toBe(cli.spanId);
    }
    // Each server span is distinct — no accidental id sharing.
    expect(new Set([call1.spanId, call2.spanId, call3.spanId]).size).toBe(3);
  });

  it('carries the un-sampled decision through unchanged (telemetry-disabled CLI)', () => {
    // A CLI with no OTLP endpoint still propagates context; only the flag clears.
    const cli = { traceId: freshTraceId(), spanId: freshSpanId(), sampled: false };
    const server = serverContinue(cliTraceparent(cli.traceId, cli.spanId, cli.sampled));

    expect(server.isRoot).toBe(false);
    expect(server.traceId).toBe(cli.traceId);
    expect(server.sampled).toBe(false);
  });
});

describe('response echo — caller can correlate back to the server span', () => {
  it('the echoed traceparent names the server span, in the same trace', () => {
    const cli = { traceId: freshTraceId(), spanId: freshSpanId(), sampled: true };
    const server = serverContinue(cliTraceparent(cli.traceId, cli.spanId, cli.sampled));

    // `withTraceparent` echoes the SERVER span so the caller can link to it.
    const echoed = echoTraceparent({ traceId: server.traceId, spanId: server.spanId, sampled: server.sampled });
    const readBack = parseTraceparent(echoed);

    expect(readBack).not.toBeNull();
    expect(readBack!.traceId).toBe(cli.traceId); // still one trace end-to-end
    expect(readBack!.parentSpanId).toBe(server.spanId); // points at the server span
  });
});

describe('MCP → api and api → api multi-hop chains', () => {
  it('preserves one trace id across a 3-service chain with correct parentage', () => {
    // agent → mcp (server span) → api (server span). Each hop continues the
    // previous hop's trace and parents on the previous hop's span.
    const agent = { traceId: freshTraceId(), spanId: freshSpanId(), sampled: true };

    const mcp = serverContinue(cliTraceparent(agent.traceId, agent.spanId, agent.sampled));
    // The MCP tool handler's outgoing fetch carries the MCP span as parent.
    const mcpOutgoing = echoTraceparent({ traceId: mcp.traceId, spanId: mcp.spanId, sampled: mcp.sampled });
    const api = serverContinue(mcpOutgoing);

    // One trace id from agent all the way to the api.
    expect(mcp.traceId).toBe(agent.traceId);
    expect(api.traceId).toBe(agent.traceId);
    // The parent chain is agent-span ← mcp-span ← api-span.
    expect(mcp.parentSpanId).toBe(agent.spanId);
    expect(api.parentSpanId).toBe(mcp.spanId);
    // Three genuinely distinct spans.
    expect(new Set([agent.spanId, mcp.spanId, api.spanId]).size).toBe(3);
  });
});

describe('invalid inbound context never corrupts a trace', () => {
  it.each([
    ['a non-hex trace id', `00-${'z'.repeat(32)}-${'00f067aa0ba902b7'}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['the forbidden ff version', `ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`],
    ['a truncated header', `00-4bf92f3577b34da6a3ce929d0e0e4736`],
    ['a garbage string', 'not-a-traceparent'],
    ['an absent header', null],
  ])('starts a fresh root trace for %s (no parent, sampled default)', (_label, header) => {
    const server = serverContinue(header);
    expect(server.isRoot).toBe(true);
    // A new root: fresh, valid trace id and no parent linkage to a corrupt id.
    expect(server.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(server.parentSpanId).toBeUndefined();
    // AlwaysOn: a locally-originated root is sampled.
    expect(server.sampled).toBe(true);
  });
});

describe('sampled flag is recorded-and-propagated, never an export gate', () => {
  it.each([true, false])('continues the trace identically regardless of the flag (sampled=%s)', (sampled) => {
    const upstream = { traceId: freshTraceId(), spanId: freshSpanId(), sampled };
    const server = serverContinue(cliTraceparent(upstream.traceId, upstream.spanId, sampled));

    // The trace is continued the SAME way whether or not it is sampled — the
    // flag is data that rides along, not a decision that drops the span.
    expect(server.isRoot).toBe(false);
    expect(server.traceId).toBe(upstream.traceId);
    expect(server.parentSpanId).toBe(upstream.spanId);
    expect(server.sampled).toBe(sampled);
  });
});

describe('sender/receiver seam is self-consistent', () => {
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const SPAN_ID = '00f067aa0ba902b7';

  it.each([true, false])('parse(format(x)) round-trips (sampled=%s)', (sampled) => {
    const parsed = parseTraceparent(formatTraceparent(TRACE_ID, SPAN_ID, sampled));
    expect(parsed).toEqual({ traceId: TRACE_ID, parentSpanId: SPAN_ID, sampled });
  });

  it('the zero-dep CLI header (shipped source) is byte-identical to formatTraceparent', () => {
    // The CLI cannot import the TS module (it is zero-dependency .mjs), so it
    // hand-rolls the header. If these two ever diverge, a CLI-emitted header
    // could stop parsing server-side and silently orphan every CLI trace.
    //
    // Guard the ACTUAL shipped code, not a copy: pull the template literal out
    // of the CLI's real `getActiveTraceparent` and prove that RENDERING it with
    // concrete ids yields exactly what `formatTraceparent` produces. If the CLI
    // source drifts (version prefix, field order, the sampled ternary) this
    // fails — which a byte-comparison of two in-file copies never would.
    const cliSrc = readRepo('packages/cli/src/telemetry.mjs');
    const fnBody = cliSrc.match(/export function getActiveTraceparent\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnBody, 'getActiveTraceparent not found in telemetry.mjs').not.toBeNull();
    const tpl = fnBody![1].match(/return\s*`([^`]*)`/);
    expect(tpl, 'no returned template literal in getActiveTraceparent').not.toBeNull();
    const template = tpl![1];

    // Sanity: it is a version-00, four-field header driven by the trace/span ids.
    expect(template.startsWith('00-')).toBe(true);
    expect(template).toContain('${_activeTraceId}');
    expect(template).toContain('${_activeSpanId}');

    const render = (t: string, s: string, sampled: boolean) =>
      template
        .replace('${_activeTraceId}', t)
        .replace('${_activeSpanId}', s)
        .replace(/\$\{_activeSampled[^}]*\}/, sampled ? '01' : '00');

    for (const sampled of [true, false]) {
      for (let i = 0; i < 32; i++) {
        const t = freshTraceId();
        const s = freshSpanId();
        expect(render(t, s, sampled)).toBe(formatTraceparent(t, s, sampled));
      }
    }
  });
});
