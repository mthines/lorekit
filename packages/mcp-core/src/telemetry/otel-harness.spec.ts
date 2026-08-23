import { describe, it, expect } from 'vitest';
// The harness is a repo-level, cross-package dev tool (like scripts/sync-edge-
// schemas.mjs); it deliberately lives outside any single package, so this test
// reaches it by path. Not a package-to-package internal import.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { buildCorrelatedTrace, HARNESS_ENVIRONMENT } from '../../../../scripts/telemetry/emit-correlated-trace.mts';

/**
 * The correlated-trace harness (`scripts/telemetry/emit-correlated-trace.mts`) is the
 * on-demand tool that emits ONE real, correlated cross-service trace to Dash0
 * for visual validation. This suite exercises its pure builder (no network) and
 * asserts the emitted OTLP is a genuinely correlated, `test`-tagged trace built
 * from each component's real emission code — so the tool can't silently start
 * producing an un-joined or un-isolatable trace.
 */

type OtlpPayload = {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] };
    scopeSpans: {
      spans: { name: string; kind: number; traceId: string; spanId: string; parentSpanId?: string; flags?: number }[];
    }[];
  }[];
};

const resourceAttrs = (p: OtlpPayload) =>
  Object.fromEntries(p.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
const spansOf = (p: OtlpPayload) => p.resourceSpans[0].scopeSpans.flatMap((s) => s.spans);

describe('correlated-trace harness — buildCorrelatedTrace', () => {
  it('emits three service blocks (cli, api, mcp-node) under ONE trace id', () => {
    const { traceId, payloads } = buildCorrelatedTrace();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(payloads.map((p) => p.serviceName)).toEqual(['cli', 'api', 'mcp-node']);

    for (const { payload } of payloads) {
      const spans = spansOf(payload as OtlpPayload);
      expect(spans.length).toBeGreaterThan(0);
      for (const s of spans) expect(s.traceId).toBe(traceId); // one trace end-to-end
    }
  });

  it('stamps every resource block with service.namespace=lorekit and the test marker', () => {
    const { payloads } = buildCorrelatedTrace();
    for (const { serviceName, payload } of payloads) {
      const attrs = resourceAttrs(payload as OtlpPayload);
      expect(attrs['service.name']).toBe(serviceName);
      expect(attrs['service.namespace']).toBe('lorekit');
      expect(attrs['deployment.environment.name']).toBe(HARNESS_ENVIRONMENT);
    }
  });

  it('honours an explicit deployment-environment override', () => {
    const { payloads } = buildCorrelatedTrace({ deploymentEnvironment: 'staging' });
    for (const { payload } of payloads) {
      expect(resourceAttrs(payload as OtlpPayload)['deployment.environment.name']).toBe('staging');
    }
  });

  it('uses correct OTel span kinds: INTERNAL cli root, SERVER edge/mcp, CLIENT db', () => {
    const { payloads } = buildCorrelatedTrace();
    const byService = Object.fromEntries(payloads.map((p) => [p.serviceName, spansOf(p.payload as OtlpPayload)]));

    // cli root is a single INTERNAL(1) span.
    expect(byService.cli.map((s) => s.kind)).toEqual([1]);
    // mcp-node hop is a SERVER(2) span.
    expect(byService['mcp-node'].map((s) => s.kind)).toEqual([2]);
    // api block carries both SERVER(2) request spans and CLIENT(3) db spans.
    const apiKinds = new Set(byService.api.map((s) => s.kind));
    expect(apiKinds.has(2)).toBe(true);
    expect(apiKinds.has(3)).toBe(true);
  });

  it('links the hops correctly: CLI→api, MCP→api, and SERVER→db, all off the cli root', () => {
    const { payloads } = buildCorrelatedTrace();
    const cliSpans = spansOf(payloads[0].payload as OtlpPayload);
    const apiSpans = spansOf(payloads[1].payload as OtlpPayload);
    const mcpSpans = spansOf(payloads[2].payload as OtlpPayload);

    const cliRoot = cliSpans[0];
    expect(cliRoot.parentSpanId).toBeUndefined(); // the CLI command span is the root

    const mcp = mcpSpans[0];
    expect(mcp.parentSpanId).toBe(cliRoot.spanId); // MCP hop hangs off the cli root

    const servers = apiSpans.filter((s) => s.kind === 2);
    const dbs = apiSpans.filter((s) => s.kind === 3);
    // One api SERVER continues the CLI command span; the other continues the MCP span.
    const serverParents = servers.map((s) => s.parentSpanId);
    expect(serverParents).toContain(cliRoot.spanId); // CLI → api
    expect(serverParents).toContain(mcp.spanId); // MCP → api
    // Every db CLIENT span is parented on an api SERVER span (the multi-hop edge chain).
    const serverIds = new Set(servers.map((s) => s.spanId));
    for (const db of dbs) expect(serverIds.has(db.parentSpanId as string)).toBe(true);
  });

  it('records the sampled flag on the exported edge spans (AlwaysOn)', () => {
    const { payloads } = buildCorrelatedTrace();
    for (const s of spansOf(payloads[1].payload as OtlpPayload)) expect(s.flags).toBe(1);
  });

  it('does not leak DEPLOYMENT_ENVIRONMENT / SERVICE_NAME into the ambient env', () => {
    const beforeDeploy = process.env.DEPLOYMENT_ENVIRONMENT;
    const beforeService = process.env.SERVICE_NAME;
    buildCorrelatedTrace({ deploymentEnvironment: 'test' });
    expect(process.env.DEPLOYMENT_ENVIRONMENT).toBe(beforeDeploy);
    expect(process.env.SERVICE_NAME).toBe(beforeService);
  });
});
