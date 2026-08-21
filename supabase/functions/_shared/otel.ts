/**
 * LoreKit — reusable OTel helper for Supabase Edge Functions (Deno)
 *
 * Design mirrors the YouStory `_shared/telemetry/` pattern:
 *  - No SDK — just OTLP/JSON via fetch()
 *  - ExportBatch: collects spans request-scoped, flushes fire-and-forget
 *    after the response via EdgeRuntime.waitUntil (guarantees export before
 *    the Deno isolate shuts down)
 *  - Span: child spans, db.statement naming for Postgres, W3C traceparent
 *  - createTracedClient(): wraps @supabase/supabase-js so every .from()
 *    chain gets an automatic child span with the SQL-like statement
 *  - traceRequest(): root entry point — extracts incoming traceparent,
 *    builds the root span, flushes the batch
 *
 * Required secrets:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.us-east-1.aws.dash0.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <token>
 *
 * VCS secrets (set via deploy-functions step in deploy.yml):
 *   VCS_REPOSITORY_URL_FULL       e.g. https://github.com/mthines/lorekit
 *   VCS_REF_HEAD_NAME             e.g. main
 *   VCS_REF_HEAD_REVISION         e.g. <git SHA>
 *   VCS_REPOSITORY_NAME           e.g. mthines/lorekit
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { formatTraceparent, parseTraceparent } from './trace-context.ts';

/** PostgREST error shape returned by @supabase/supabase-js. */
type PostgrestError = { message: string; details?: string | null; hint?: string | null; code?: string };

/** Typed PostgREST response wrapper. */
type PostgrestResponse<T> = {
  data: T | null;
  error: PostgrestError | null;
  count?: number | null;
};

// ── Supabase Edge Runtime global ──────────────────────────────────────────────
declare global {
  // deno-lint-ignore no-var
  // eslint-disable-next-line no-var -- `declare global` ambient vars require `var`, not let/const
  var EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
}

// ── Config ────────────────────────────────────────────────────────────────────

function getOtlpConfig(): { endpoint: string; headers: Record<string, string> } | null {
  const endpoint = Deno.env.get('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint) return null;

  const raw = Deno.env.get('OTEL_EXPORTER_OTLP_HEADERS') ?? '';
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  // Dataset routing, highest precedence first: an explicit `Dash0-Dataset`
  // already parsed from OTEL_EXPORTER_OTLP_HEADERS wins and is never clobbered;
  // otherwise DASH0_DATASET; otherwise `default`, so edge telemetry lands
  // alongside every other LoreKit component. HTTP header names are
  // case-insensitive, so match any casing the caller used rather than only the
  // canonical spelling — otherwise a second, conflicting header would be added.
  const hasDataset = Object.keys(headers).some((k) => k.toLowerCase() === 'dash0-dataset');
  if (!hasDataset) {
    headers['Dash0-Dataset'] = Deno.env.get('DASH0_DATASET') || 'default';
  }

  return { endpoint: endpoint.replace(/\/+$/, ''), headers };
}

// ── VCS resource attributes ───────────────────────────────────────────────────
/**
 * Resolve VCS identity from environment variables injected at deploy time.
 *
 * Priority per attribute:
 *   1. `VCS_*` Supabase secrets — set by the deploy workflow step
 *      "Set VCS resource attributes" (mirrors the yourstory-ai pattern).
 *   2. Native GitHub Actions env vars — picked up automatically when running
 *      `deno test` inside a CI runner.
 *
 * Attributes with no value are omitted so the OTLP payload never carries
 * empty strings for VCS fields. Local development emits no vcs.* attributes
 * (correct — Deno Edge Function isolates have no git access).
 *
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
 */
function getVcsResourceAttributes(): Record<string, string> {
  const repositoryUrlFull =
    Deno.env.get('VCS_REPOSITORY_URL_FULL') ?? buildGitHubRepoUrl(Deno.env.get('GITHUB_REPOSITORY'));

  const refHeadName =
    Deno.env.get('VCS_REF_HEAD_NAME') ?? Deno.env.get('GITHUB_REF_NAME');

  const refHeadRevision =
    Deno.env.get('VCS_REF_HEAD_REVISION') ?? Deno.env.get('GITHUB_SHA');

  const repositoryName =
    Deno.env.get('VCS_REPOSITORY_NAME') ?? Deno.env.get('GITHUB_REPOSITORY');

  const attrs: Record<string, string> = {};
  if (repositoryUrlFull) attrs['vcs.repository.url.full'] = repositoryUrlFull;
  if (refHeadName) {
    attrs['vcs.ref.head.name'] = refHeadName;
    // Only emit type when ref name is present; Edge Functions always deploy
    // from a branch, never a tag.
    attrs['vcs.ref.head.type'] = 'branch';
  }
  if (refHeadRevision) attrs['vcs.ref.head.revision'] = refHeadRevision;
  if (repositoryName) attrs['vcs.repository.name'] = repositoryName;

  return attrs;
}

/** Build the canonical GitHub HTTPS URL from a `GITHUB_REPOSITORY` value. */
function buildGitHubRepoUrl(repository: string | undefined): string | undefined {
  if (!repository) return undefined;
  return `https://github.com/${repository}`;
}

// ── Trace context (W3C traceparent) ──────────────────────────────────────────

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /**
   * The inbound W3C `sampled` flag (or `true` for a locally-originated root).
   *
   * IMPORTANT: this flag is RECORDED and PROPAGATED, never ACTED ON. LoreKit
   * exports every span (AlwaysOn) and defers sampling to the Dash0 pipeline —
   * see "Key decisions" in the root CLAUDE.md. Do not turn this into an
   * export gate.
   */
  sampled: boolean;
}

// OTLP `Span.kind` values. Root request spans are SERVER, outgoing DB calls
// are CLIENT; anything else stays INTERNAL. Without these no APM can draw
// service-to-service edges.
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_SERVER = 2;
export const SPAN_KIND_CLIENT = 3;

function randHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the trace context for an incoming request. A spec-invalid
 * `traceparent` (wrong shape, non-hex, all-zero ids, version `ff`, …) is
 * rejected by `parseTraceparent` and falls back to a NEW root trace rather
 * than producing a corrupt, unlinkable span.
 */
function extractTraceContext(req: Request): TraceContext {
  const parsed = parseTraceparent(req.headers.get('traceparent'));
  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: randHex(8),
      parentSpanId: parsed.parentSpanId,
      sampled: parsed.sampled,
    };
  }
  // Locally-originated trace: preserve today's AlwaysOn behaviour.
  return { traceId: randHex(16), spanId: randHex(8), sampled: true };
}

// ── OTLP export batch ─────────────────────────────────────────────────────────
// Spans are collected during the request and flushed after the response is sent.
// EdgeRuntime.waitUntil ensures the export completes before the isolate dies.

interface SpanPayload {
  ctx: TraceContext;
  name: string;
  kind: number;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  statusMessage?: string;
}

function toOtlpValue(v: string | number | boolean) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v) };
}

/**
 * Resolve deployment environment for the `deployment.environment.name` resource
 * attribute.
 *
 * Priority:
 *   1. `DEPLOYMENT_ENVIRONMENT` — an explicit override. This is the single,
 *      env-driven path every LoreKit component honours so a correlated-trace
 *      run can stamp `test` uniformly (see `scripts/emit-correlated-trace.mts`)
 *      and any deployment can name its environment directly.
 *   2. `VERCEL_ENV` — mapped to production / preview / development.
 *   3. (absent) → 'local'.
 *
 * Set either as a Supabase secret. The override wins so it can pin the value
 * regardless of the ambient Vercel signal.
 */
function resolveDeploymentEnv(): string {
  const override = Deno.env.get('DEPLOYMENT_ENVIRONMENT');
  if (override) return override;
  const env = Deno.env.get('VERCEL_ENV');
  if (env === 'production') return 'production';
  if (env === 'preview') return 'preview';
  if (env === 'development') return 'development';
  return 'local';
}

export function buildOtlpPayload(
  spans: SpanPayload[],
  opts: { environmentOverride?: string } = {},
): unknown {
  // Build vcs.* resource attributes once per payload (they are constant for
  // the lifetime of the isolate — resolved from Supabase secrets at startup).
  const vcsAttrs = getVcsResourceAttributes();

  const serviceVersion = Deno.env.get('VCS_REF_HEAD_REVISION') ?? Deno.env.get('GITHUB_SHA') ?? 'unknown';

  // Every Supabase Edge Function is ONE logical service: `api`. The individual
  // functions (memories, orgs, openapi, mcp, health) are operations on it, not
  // separate services — they share a deployment, a database and a lifecycle,
  // and splitting them would fragment the service map for no analytical gain.
  //
  // This is a build-time constant on purpose. It used to be a per-function
  // `SERVICE_NAME` Supabase secret, which could not work: Supabase secrets are
  // project-wide, not per-function, so a single value could never name five
  // functions. Functions that went unconfigured silently fell back to a shared
  // name anyway. The env var is still honoured as an escape hatch, but nothing
  // needs to set it.
  //
  // Distinguish functions and operations with `faas.name` and the span name
  // (`lorekit.memories`, `lorekit.mcp`, …), both set by `traceRequest`.
  const serviceName = Deno.env.get('SERVICE_NAME') ?? 'api';
  const resourceAttributes = [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.namespace', value: { stringValue: 'lorekit' } },
    { key: 'service.version', value: { stringValue: serviceVersion } },
    // A caller-supplied override (a smoke run's `test`) wins over the isolate's
    // ambient environment, so synthetic traffic against a production deployment
    // still reports `test`. Validated to the allowlist before it reaches here.
    { key: 'deployment.environment.name', value: { stringValue: opts.environmentOverride ?? resolveDeploymentEnv() } },
    ...Object.entries(vcsAttrs).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    })),
  ];

  return {
    resourceSpans: [{
      resource: { attributes: resourceAttributes },
      scopeSpans: [{
        scope: { name: `lorekit-${serviceName}`, version: '1.0.0' },
        spans: spans.map((s) => ({
          traceId: s.ctx.traceId,
          spanId: s.ctx.spanId,
          ...(s.ctx.parentSpanId ? { parentSpanId: s.ctx.parentSpanId } : {}),
          name: s.name,
          kind: s.kind,
          // W3C sampled bit, recorded for downstream consumers. Export itself
          // stays AlwaysOn — sampling is deferred to the Dash0 pipeline, so
          // never turn this into a drop condition.
          flags: s.ctx.sampled ? 1 : 0,
          startTimeUnixNano: String(s.startMs * 1_000_000),
          endTimeUnixNano: String(s.endMs * 1_000_000),
          attributes: Object.entries(s.attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) })),
          status: {
            code: s.status === 'error' ? 2 : 1,
            ...(s.statusMessage ? { message: s.statusMessage } : {}),
          },
        })),
      }],
    }],
  };
}

export class ExportBatch {
  private spans: SpanPayload[] = [];
  /**
   * Optional per-request `deployment.environment.name` override (a smoke run's
   * `test`). Set by `traceRequest` from a validated header; applied at flush so
   * a request against a production deployment can still report synthetic env.
   */
  environmentOverride?: string;

  add(span: SpanPayload): void { this.spans.push(span); }

  /**
   * Remove and return the collected spans. Used by the offline correlated-trace
   * harness to hand the real, edge-built spans to `buildOtlpPayload` without
   * going through the fire-and-forget `flush()` (which reads Deno secrets and
   * posts). Not used on the request path.
   */
  drain(): SpanPayload[] {
    const spans = this.spans;
    this.spans = [];
    return spans;
  }

  /**
   * Build and POST the collected spans; `null` when there is nothing to send.
   *
   * Split out of `flush()` so the same body serves both the fire-and-forget
   * request-path flush and the awaitable `flushAsync()` — two copies of the
   * payload build would be two places for the environment override to drift.
   */
  private post(): Promise<void> | null {
    if (this.spans.length === 0) return null;
    const cfg = getOtlpConfig();
    if (!cfg) return null;

    const payload = buildOtlpPayload([...this.spans], { environmentOverride: this.environmentOverride });
    this.spans = [];

    return fetch(`${cfg.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify(payload),
    }).then(() => { /* discard the response */ }, () => { /* swallow */ });
  }

  /** Fire-and-forget flush — use EdgeRuntime.waitUntil when available. */
  flush(): void {
    const p = this.post();
    if (!p) return;

    if (typeof globalThis.EdgeRuntime?.waitUntil === 'function') {
      globalThis.EdgeRuntime.waitUntil(p);
    } else {
      void p;
    }
  }

  /**
   * Flush and RESOLVE once the export request has settled.
   *
   * `flush()` is right on the request path: the isolate is held open by the
   * runtime's own `waitUntil`. A BACKGROUND task has no such keep-alive to
   * inherit — it IS the keep-alive — so it must be able to await its own
   * export, or the isolate can be torn down with the POST in flight and the
   * spans are lost exactly as if they had never been recorded.
   */
  async flushAsync(): Promise<void> {
    await (this.post() ?? Promise.resolve());
  }
}

// ── Span ──────────────────────────────────────────────────────────────────────

export class Span {
  private startMs = Date.now();
  private attributes: Record<string, string | number | boolean> = {};
  private status: 'ok' | 'error' = 'ok';
  private statusMessage?: string;
  readonly ctx: TraceContext;

  constructor(
    private name: string,
    ctx: TraceContext,
    private batch: ExportBatch,
    /** OTLP span kind — SERVER for the root request span, CLIENT for DB calls. */
    private kind: number = SPAN_KIND_INTERNAL,
  ) {
    this.ctx = ctx;
  }

  /**
   * Create a child span sharing the same trace ID. Children inherit the
   * parent's `sampled` flag; `kind` defaults to INTERNAL.
   */
  child(
    childName: string,
    initialAttrs: Record<string, string | number | boolean> = {},
    kind: number = SPAN_KIND_INTERNAL,
  ): Span {
    const childCtx: TraceContext = {
      traceId: this.ctx.traceId,
      spanId: randHex(8),
      parentSpanId: this.ctx.spanId,
      sampled: this.ctx.sampled,
    };
    const s = new Span(childName, childCtx, this.batch, kind);
    if (Object.keys(initialAttrs).length) s.setAttributes(initialAttrs);
    return s;
  }

  /**
   * A child span that exports on its OWN batch, for work that OUTLIVES the
   * response.
   *
   * `traceRequest` ends the root span and calls `batch.flush()` in a `finally`,
   * and `flush()` DRAINS the batch. A task backgrounded with
   * `EdgeRuntime.waitUntil` resolves after that, so every span it records
   * through `child()` — and every attribute it sets on the root span — lands in
   * a batch that has already been posted and will never be posted again. The
   * symptom is silent: the enqueue is visible and the outcome is not.
   *
   * The returned `flush` is the background task's own export and it MUST be
   * awaited when the task finishes (see `ExportBatch.flushAsync`). In-request
   * work keeps using `child()` so the whole trace still exports as one batch.
   */
  detachedChild(
    childName: string,
    initialAttrs: Record<string, string | number | boolean> = {},
    kind: number = SPAN_KIND_INTERNAL,
  ): { span: Span; flush: () => Promise<void> } {
    const batch = new ExportBatch();
    batch.environmentOverride = this.batch.environmentOverride;
    const childCtx: TraceContext = {
      traceId: this.ctx.traceId,
      spanId: randHex(8),
      parentSpanId: this.ctx.spanId,
      sampled: this.ctx.sampled,
    };
    const s = new Span(childName, childCtx, batch, kind);
    if (Object.keys(initialAttrs).length) s.setAttributes(initialAttrs);
    return { span: s, flush: () => batch.flushAsync() };
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  error(message: string): this {
    this.status = 'error';
    this.statusMessage = message;
    this.attributes['error.message'] = message;
    return this;
  }

  /**
   * Record a client-caused problem (bad input, missing auth, wrong scope, etc.)
   * WITHOUT marking the span status as ERROR. The service handled the request
   * correctly — the fault lies with the caller.
   *
   * Use this instead of `.error()` whenever the response would be a 4xx or an
   * in-band JSON-RPC error caused by the caller's input (e.g. invalid scope,
   * invalid JSON body, insufficient token permissions). Per the OTel semantic
   * conventions, server spans should only carry status=ERROR for server-side
   * faults, not for client errors.
   */
  clientError(message: string): this {
    this.attributes['error.message'] = message;
    return this;
  }

  /** End the span and add it to the batch. */
  end(): void {
    this.batch.add({
      ctx: this.ctx,
      name: this.name,
      kind: this.kind,
      startMs: this.startMs,
      endMs: Date.now(),
      attributes: this.attributes,
      status: this.status,
      statusMessage: this.statusMessage,
    });
  }
}

// ── traceRequest — root entry point ──────────────────────────────────────────

/**
 * Derive the `faas.name` attribute from a root span's operation name.
 *
 * Operation names are `lorekit.<function>` (`lorekit.memories`,
 * `lorekit.mcp`, `lorekit.webhook.github`, …). We take the segment after the
 * `lorekit.` prefix, so `lorekit.webhook.github` reports `webhook.github` —
 * the sub-operation is kept because it is a genuinely distinct entry point.
 * A name without the prefix is passed through unchanged.
 */
function faasNameFrom(operationName: string): string {
  return operationName.startsWith('lorekit.') ? operationName.slice('lorekit.'.length) : operationName;
}

/**
 * Values the `X-LoreKit-Deployment-Environment` request header is allowed to set
 * `deployment.environment.name` to. Restricted to the single SYNTHETIC value
 * `test` on purpose: LoreKit's own smoke suites send it (the CLI forwards
 * `DEPLOYMENT_ENVIRONMENT`, the REST/MCP smoke specs send it directly) so a
 * deploy-pipeline run's server spans are tagged `test` and filter apart from
 * real traffic in Dash0. A caller can therefore only mark its own traffic as
 * synthetic — never relabel itself as `production`/`preview` — so the header can
 * hide a caller's own spans from an env=production view but can never forge a
 * different real environment. It changes only an observability tag: no auth,
 * tenancy, limit, or behaviour depends on it.
 */
const HEADER_ENV_ALLOWLIST = new Set(['test']);

/**
 * Resolve a caller-supplied `deployment.environment.name` override from the
 * `X-LoreKit-Deployment-Environment` header, or `undefined` when absent or not
 * in the allowlist. Unlike a resource attribute the isolate fixes at boot, this
 * is applied per request batch (each request flushes its own ExportBatch), which
 * is what lets a smoke request against a production deployment report `test`.
 */
function resolveEnvironmentOverride(req: Request): string | undefined {
  const raw = req.headers.get('x-lorekit-deployment-environment');
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  return HEADER_ENV_ALLOWLIST.has(t) ? t : undefined;
}

/**
 * Return a Response carrying the server span's `traceparent`, so a browser or
 * CLI can correlate its request with the server-side trace.
 *
 * A Response's headers can be immutable (anything produced by `fetch()` or
 * `Response.redirect()`), so we never mutate in place — we copy the headers and
 * rebuild the Response, preserving status, statusText and body. Bodiless
 * statuses (204/304) are safe: such a Response always has `body === null`, and
 * `new Response(null, { status })` is legal for them.
 *
 * The header is only readable cross-origin because `api/cors.ts` emits
 * `Access-Control-Expose-Headers: traceparent`.
 */
function withTraceparent<T extends Response>(response: T, ctx: TraceContext): T {
  const headers = new Headers(response.headers);
  headers.set('traceparent', formatTraceparent(ctx.traceId, ctx.spanId, ctx.sampled));
  const correlated = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  // The generic exists only so callers keep their Response subtype; no
  // subtype is used in this repo, and a plain Response is behaviourally
  // identical for every caller.
  return correlated as T;
}

/**
 * Wrap the entire request handler in a root span. Extracts incoming
 * W3C traceparent so browser→server spans are linked. Flushes the batch
 * after the response is built.
 *
 * @example
 * ```ts
 * Deno.serve(async (req) => {
 *   return await traceRequest(req, 'lorekit.mcp', async (span) => {
 *     // span is the root SERVER span
 *     const tracedDb = createTracedClient(db, span);
 *     return await handleMcp(req, auth, tracedDb, span);
 *   });
 * });
 * ```
 */
export async function traceRequest<T extends Response>(
  req: Request,
  operationName: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const batch = new ExportBatch();
  // A smoke/test run may ask (via header) to report `deployment.environment.name
  // = test` so its spans filter apart from real traffic; applied to this
  // request's whole span batch at flush.
  batch.environmentOverride = resolveEnvironmentOverride(req);
  const ctx = extractTraceContext(req);
  const span = new Span(operationName, ctx, batch, SPAN_KIND_SERVER);

  span.setAttributes({
    'http.request.method': req.method,
    'url.path': new URL(req.url).pathname,
    // Every edge function reports service.name = 'api', so this is what tells
    // them apart. Derived from the operation name ('lorekit.memories' →
    // 'memories') so a new function gets it for free and cannot forget to.
    'faas.name': faasNameFrom(operationName),
  });

  let response: T;
  try {
    response = await fn(span);
    span.setAttributes({ 'http.response.status_code': response.status });
    return withTraceparent(response, ctx);
  } catch (err) {
    span.error(`${(err as Error).name}: ${(err as Error).message}`);
    throw err;
  } finally {
    span.end();
    batch.flush(); // fire-and-forget after response
  }
}

// ── createTracedClient — automatic DB spans ───────────────────────────────────

type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT' | 'RPC';

interface QueryState {
  table: string;
  op: Op;
  columns: string;
  filters: string[];
  orderBy?: string;
  lim?: number;
  /**
   * The postgrest builder being accumulated. Deliberately untyped, because the
   * real type CHANGES ALONG THE CHAIN and no single annotation describes it:
   * `.from()` yields a `PostgrestQueryBuilder` (select / insert / update /
   * delete), and `.select()` yields a `PostgrestFilterBuilder` (eq / gt / in /
   * order / limit …). The two share almost no methods.
   *
   * This was `ReturnType<SupabaseClient['from']>`, i.e. the FIRST of those two,
   * which made every filter call below a type error — `Property 'eq' does not
   * exist on type 'PostgrestQueryBuilder'` and so on, 34 of them. Nothing
   * noticed because no typechecker had ever run over this tree; `overlaps()`
   * below already carried an `as any` for a narrower instance of the same
   * problem.
   *
   * `TracedQuery` exists precisely to erase this distinction — it presents one
   * flat fluent surface and records SQL text as it goes — so the honest
   * annotation is the permissive one, with the method signatures on
   * `TracedQuery` serving as the contract callers actually see.
   */
  // deno-lint-ignore no-explicit-any -- see above: the builder's type changes along the chain
  qb: any;
}

function buildSql(s: QueryState): string {
  const parts: string[] = [];
  switch (s.op) {
    case 'SELECT': parts.push(`SELECT ${s.columns || '*'} FROM ${s.table}`); break;
    case 'INSERT': parts.push(`INSERT INTO ${s.table}${s.columns ? ` (${s.columns})` : ''}`); break;
    case 'UPDATE': parts.push(`UPDATE ${s.table} SET ...`); break;
    case 'DELETE': parts.push(`DELETE FROM ${s.table}`); break;
    case 'UPSERT': parts.push(`UPSERT INTO ${s.table}${s.columns ? ` (${s.columns})` : ''}`); break;
    case 'RPC': parts.push(`CALL ${s.table}(...)`); break;
  }
  if (s.filters.length) parts.push(`WHERE ${s.filters.join(' AND ')}`);
  if (s.orderBy) parts.push(`ORDER BY ${s.orderBy}`);
  if (s.lim !== undefined) parts.push(`LIMIT ${s.lim}`);
  return parts.join(' ');
}

/**
 * Fluent traced query builder — mirrors the Supabase query builder API
 * but wraps execution in a child span named after the SQL-like statement.
 */
export class TracedQuery<T = Record<string, unknown>> {
  constructor(private state: QueryState, private parent: Span) {}

  // ── column selection ──────────────────────────────────────────────────────
  select(cols = '*', opts?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' }): this {
    this.state.columns = cols;
    this.state.qb = this.state.qb.select(cols, opts);
    return this;
  }

  // ── filters ───────────────────────────────────────────────────────────────
  eq(col: string, val: unknown): this   { this.state.filters.push(`${col} = '${val}'`);  this.state.qb = this.state.qb.eq(col, val); return this; }
  neq(col: string, val: unknown): this  { this.state.filters.push(`${col} != '${val}'`); this.state.qb = this.state.qb.neq(col, val); return this; }
  gt(col: string, val: unknown): this   { this.state.filters.push(`${col} > '${val}'`);  this.state.qb = this.state.qb.gt(col, val); return this; }
  gte(col: string, val: unknown): this  { this.state.filters.push(`${col} >= '${val}'`); this.state.qb = this.state.qb.gte(col, val); return this; }
  lt(col: string, val: unknown): this   { this.state.filters.push(`${col} < '${val}'`);  this.state.qb = this.state.qb.lt(col, val); return this; }
  lte(col: string, val: unknown): this  { this.state.filters.push(`${col} <= '${val}'`); this.state.qb = this.state.qb.lte(col, val); return this; }
  is(col: string, val: unknown): this   { this.state.filters.push(`${col} IS ${val}`);   this.state.qb = this.state.qb.is(col, val); return this; }
  in<V = unknown>(col: string, vals: V[]): this    { this.state.filters.push(`${col} IN (${vals.map((v) => `'${v}'`).join(', ')})`); this.state.qb = this.state.qb.in(col, vals); return this; }
  // `val` may be a STRING array literal (`{"a","b,c"}`) as well as an array.
  // postgrest-js forwards a string verbatim as `ov.<val>` / `cs.<val>`
  // (PostgrestFilterBuilder 2.110.8) — that overload is what lets
  // `pgArrayLiteral` (@lorekit/schemas/tags) own the Postgres quoting. An
  // ARRAY is joined with a bare `,`, which mis-parses a label containing a
  // comma/brace/quote into several labels, so do NOT narrow these back to
  // `V[]`: `memories.tags` is free text with no CHECK constraint.
  overlaps<V = unknown>(col: string, val: V[] | string): this {
    this.state.filters.push(`${col} && '${typeof val === 'string' ? val : `{${val.join(',')}}`}'`);
    // deno-lint-ignore no-explicit-any -- the string|array overload isn't in the narrowed public type
    this.state.qb = (this.state.qb as any).overlaps(col, val);
    return this;
  }
  contains<V = unknown>(col: string, val: V[] | string | Record<string, unknown>): this {
    const rendered = typeof val === 'string'
      ? val
      : Array.isArray(val) ? `{${val.join(',')}}` : JSON.stringify(val);
    this.state.filters.push(`${col} @> '${rendered}'`);
    // deno-lint-ignore no-explicit-any -- PostgREST builder's .contains() overloads vary by version
    this.state.qb = (this.state.qb as any).contains(col, val);
    return this;
  }
  textSearch(col: string, query: string, opts?: { type?: string; config?: string }): this {
    this.state.filters.push(`${col} @@ to_tsquery('${query}')`);
    // deno-lint-ignore no-explicit-any -- PostgREST builder lacks textSearch overload in its public type
    this.state.qb = (this.state.qb as any).textSearch(col, query, opts);
    return this;
  }
  or(filters: string, opts?: { referencedTable?: string }): this {
    this.state.filters.push(`(${filters})`);
    this.state.qb = this.state.qb.or(filters, opts);
    return this;
  }
  not(col: string, operator: string, val: unknown): this {
    this.state.filters.push(`${col} NOT ${operator} '${val}'`);
    // deno-lint-ignore no-explicit-any -- PostgREST builder's .not() types vary by version
    this.state.qb = (this.state.qb as any).not(col, operator, val);
    return this;
  }

  // ── ordering & pagination ─────────────────────────────────────────────────
  order(col: string, opts?: { ascending?: boolean }): this {
    this.state.orderBy = `${col} ${opts?.ascending === false ? 'DESC' : 'ASC'}`;
    this.state.qb = this.state.qb.order(col, opts);
    return this;
  }
  limit(n: number): this { this.state.lim = n; this.state.qb = this.state.qb.limit(n); return this; }

  // ── result modifiers ──────────────────────────────────────────────────────
  single(): this   { this.state.lim = 1; this.state.qb = this.state.qb.single(); return this; }
  maybeSingle(): this { this.state.lim = 1; this.state.qb = this.state.qb.maybeSingle(); return this; }

  // ── mutations ─────────────────────────────────────────────────────────────
  insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this.state.op = 'INSERT';
    const sample = Array.isArray(data) ? data[0] : data;
    if (sample) this.state.columns = Object.keys(sample).join(', ');
    this.state.qb = this.state.qb.insert(data);
    return this;
  }
  update(data: Record<string, unknown>, opts?: { count?: 'exact' | 'planned' | 'estimated' }): this {
    this.state.op = 'UPDATE';
    this.state.columns = Object.keys(data).join(', ');
    // Forward opts (e.g. { count: 'exact' }) — without this the row count is
    // dropped, so soft-delete/archive report archived:false even on success.
    this.state.qb = this.state.qb.update(data, opts);
    return this;
  }
  upsert(data: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }): this {
    this.state.op = 'UPSERT';
    const sample = Array.isArray(data) ? data[0] : data;
    if (sample) this.state.columns = Object.keys(sample).join(', ');
    this.state.qb = this.state.qb.upsert(data, opts);
    return this;
  }
  delete(opts?: { count?: 'exact' | 'planned' | 'estimated' }): this {
    this.state.op = 'DELETE';
    // deno-lint-ignore no-explicit-any -- PostgREST builder's .delete() opts aren't in the public type
    this.state.qb = (this.state.qb as any).delete(opts);
    return this;
  }

  // ── execution (with child span) ───────────────────────────────────────────
  /** Execute the query. Result is typed via the TracedQuery<T> generic. */
  then<R1 = PostgrestResponse<T[]>, R2 = never>(
    resolve?: ((v: PostgrestResponse<T[]>) => R1 | PromiseLike<R1>) | null,
    reject?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const sql = buildSql(this.state);
    const dbSpan = this.parent.child(sql, {
      'db.system': 'postgresql',
      'db.operation.name': this.state.op,
      'db.collection.name': this.state.table,
      'db.query.text': sql,
    }, SPAN_KIND_CLIENT);

    // deno-lint-ignore no-explicit-any -- PostgREST builder is awaited as opaque; result is cast below
    const resultPromise = (this.state.qb as any) as Promise<PostgrestResponse<T[]>>;

    return resultPromise.then(
      (result) => {
        const rows = Array.isArray(result.data) ? result.data.length : result.data ? 1 : 0;
        dbSpan.setAttributes({ 'db.response.rows': rows, 'db.success': !result.error });

        if (result.error) {
          if (result.error.code === 'PGRST116') {
            // .single() no rows — expected, not an error
            dbSpan.setAttributes({ 'db.no_rows': true });
          } else {
            dbSpan.error(`PostgrestError: ${result.error.message}`);
          }
        }

        dbSpan.end();
        return resolve ? resolve(result) : result as unknown as R1;
      },
      (err: unknown) => {
        dbSpan.error(`${(err as Error).name}: ${(err as Error).message}`);
        dbSpan.end();
        return reject ? reject(err) : Promise.reject(err) as Promise<R2>;
      },
    );
  }
}

/**
 * Wrap a Supabase client so every `.from()` call returns a TracedQuery
 * that auto-spans with the SQL-like statement name.
 *
 * @example
 * ```ts
 * const db = createTracedClient(supabase, span);
 * const { data } = await db
 *   .from('memories')
 *   .select('key,value')
 *   .eq('scope', scope)
 *   .limit(50);
 * // → child span: "SELECT key,value FROM memories WHERE scope = '...' LIMIT 50"
 * ```
 */
export function createTracedClient(supabase: SupabaseClient, parentSpan: Span) {
  return {
    from<T = Record<string, unknown>>(table: string): TracedQuery<T> {
      return new TracedQuery<T>(
        { table, op: 'SELECT', columns: '*', filters: [], qb: supabase.from(table) },
        parentSpan,
      );
    },
    rpc<T = Record<string, unknown>>(fn: string, args?: Record<string, unknown>, opts?: Record<string, unknown>): TracedQuery<T> {
      return new TracedQuery<T>(
        // deno-lint-ignore no-explicit-any -- SupabaseClient.rpc() generic overload isn't publicly typed; cast is safe
        { table: fn, op: 'RPC', columns: '', filters: [], qb: (supabase as any).rpc(fn, args, opts) },
        parentSpan,
      );
    },
  };
}

export type TracedSupabaseClient = ReturnType<typeof createTracedClient>;
