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
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Supabase Edge Runtime global ──────────────────────────────────────────────
declare global {
  // deno-lint-ignore no-var
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
  const dataset = Deno.env.get('DASH0_DATASET');
  if (dataset) headers['Dash0-Dataset'] = dataset;

  return { endpoint: endpoint.replace(/\/+$/, ''), headers };
}

// ── Trace context (W3C traceparent) ──────────────────────────────────────────

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

function randHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function extractTraceContext(req: Request): TraceContext {
  const tp = req.headers.get('traceparent');
  if (tp) {
    const parts = tp.split('-');
    if (parts.length === 4 && parts[1]?.length === 32 && parts[2]?.length === 16) {
      return { traceId: parts[1], spanId: randHex(8), parentSpanId: parts[2] };
    }
  }
  return { traceId: randHex(16), spanId: randHex(8) };
}

// ── OTLP export batch ─────────────────────────────────────────────────────────
// Spans are collected during the request and flushed after the response is sent.
// EdgeRuntime.waitUntil ensures the export completes before the isolate dies.

interface SpanPayload {
  ctx: TraceContext;
  name: string;
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

function buildOtlpPayload(spans: SpanPayload[]): unknown {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'lorekit-mcp' } },
          { key: 'deployment.environment.name', value: { stringValue: Deno.env.get('DEPLOYMENT_ENV') ?? 'production' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'lorekit-mcp', version: '1.0.0' },
        spans: spans.map((s) => ({
          traceId: s.ctx.traceId,
          spanId: s.ctx.spanId,
          ...(s.ctx.parentSpanId ? { parentSpanId: s.ctx.parentSpanId } : {}),
          name: s.name,
          kind: 1, // INTERNAL
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

class ExportBatch {
  private spans: SpanPayload[] = [];

  add(span: SpanPayload): void { this.spans.push(span); }

  /** Fire-and-forget flush — use EdgeRuntime.waitUntil when available. */
  flush(): void {
    if (this.spans.length === 0) return;
    const cfg = getOtlpConfig();
    if (!cfg) return;

    const payload = buildOtlpPayload([...this.spans]);
    this.spans = [];

    const p = fetch(`${cfg.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify(payload),
    }).catch(() => { /* swallow */ });

    if (typeof globalThis.EdgeRuntime?.waitUntil === 'function') {
      globalThis.EdgeRuntime.waitUntil(p);
    } else {
      void p;
    }
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
  ) {
    this.ctx = ctx;
  }

  /** Create a child span sharing the same trace ID. */
  child(childName: string, initialAttrs: Record<string, string | number | boolean> = {}): Span {
    const childCtx: TraceContext = {
      traceId: this.ctx.traceId,
      spanId: randHex(8),
      parentSpanId: this.ctx.spanId,
    };
    const s = new Span(childName, childCtx, this.batch);
    if (Object.keys(initialAttrs).length) s.setAttributes(initialAttrs);
    return s;
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

  /** End the span and add it to the batch. */
  end(): void {
    this.batch.add({
      ctx: this.ctx,
      name: this.name,
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
  const ctx = extractTraceContext(req);
  const span = new Span(operationName, ctx, batch);

  span.setAttributes({
    'http.request.method': req.method,
    'url.path': new URL(req.url).pathname,
  });

  let response: T;
  try {
    response = await fn(span);
    span.setAttributes({ 'http.response.status_code': response.status });
    return response;
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
  qb: ReturnType<SupabaseClient['from']>;
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
// deno-lint-ignore no-explicit-any
export class TracedQuery<T = any> {
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
  // deno-lint-ignore no-explicit-any
  in(col: string, vals: any[]): this    { this.state.filters.push(`${col} IN (${vals.map((v) => `'${v}'`).join(', ')})`); this.state.qb = this.state.qb.in(col, vals); return this; }
  // deno-lint-ignore no-explicit-any
  overlaps(col: string, val: any[]): this { this.state.filters.push(`${col} && '{${val.join(',')}}'`); this.state.qb = this.state.qb.overlaps(col, val); return this; }
  textSearch(col: string, query: string, opts?: { type?: string; config?: string }): this {
    this.state.filters.push(`${col} @@ to_tsquery('${query}')`);
    // deno-lint-ignore no-explicit-any
    this.state.qb = (this.state.qb as any).textSearch(col, query, opts);
    return this;
  }
  or(filters: string, opts?: { referencedTable?: string }): this {
    this.state.filters.push(`(${filters})`);
    this.state.qb = this.state.qb.or(filters, opts);
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
  // deno-lint-ignore no-explicit-any
  insert(data: any | any[]): this {
    this.state.op = 'INSERT';
    const sample = Array.isArray(data) ? data[0] : data;
    if (sample) this.state.columns = Object.keys(sample).join(', ');
    this.state.qb = this.state.qb.insert(data);
    return this;
  }
  // deno-lint-ignore no-explicit-any
  update(data: any): this {
    this.state.op = 'UPDATE';
    this.state.columns = Object.keys(data).join(', ');
    this.state.qb = this.state.qb.update(data);
    return this;
  }
  // deno-lint-ignore no-explicit-any
  upsert(data: any | any[], opts?: { onConflict?: string }): this {
    this.state.op = 'UPSERT';
    const sample = Array.isArray(data) ? data[0] : data;
    if (sample) this.state.columns = Object.keys(sample).join(', ');
    this.state.qb = this.state.qb.upsert(data, opts);
    return this;
  }
  delete(opts?: { count?: 'exact' | 'planned' | 'estimated' }): this {
    this.state.op = 'DELETE';
    // deno-lint-ignore no-explicit-any
    this.state.qb = (this.state.qb as any).delete(opts);
    return this;
  }

  // ── execution (with child span) ───────────────────────────────────────────
  // deno-lint-ignore no-explicit-any
  async then<R1 = any, R2 = never>(
    // deno-lint-ignore no-explicit-any
    resolve?: ((v: any) => R1 | PromiseLike<R1>) | null,
    // deno-lint-ignore no-explicit-any
    reject?: ((r: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const sql = buildSql(this.state);
    const dbSpan = this.parent.child(sql, {
      'db.system': 'postgresql',
      'db.operation.name': this.state.op,
      'db.collection.name': this.state.table,
      'db.query.text': sql,
    });

    try {
      // deno-lint-ignore no-explicit-any
      const result = await (this.state.qb as any);
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
      return resolve ? resolve(result) : result;
    } catch (err) {
      dbSpan.error(`${(err as Error).name}: ${(err as Error).message}`);
      dbSpan.end();
      return reject ? reject(err) : Promise.reject(err);
    }
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
    from(table: string): TracedQuery {
      return new TracedQuery(
        { table, op: 'SELECT', columns: '*', filters: [], qb: supabase.from(table) },
        parentSpan,
      );
    },
    // deno-lint-ignore no-explicit-any
    rpc(fn: string, args?: Record<string, unknown>, opts?: Record<string, unknown>): TracedQuery {
      return new TracedQuery(
        // deno-lint-ignore no-explicit-any
        { table: fn, op: 'RPC', columns: '', filters: [], qb: (supabase as any).rpc(fn, args, opts) },
        parentSpan,
      );
    },
  };
}

export type TracedSupabaseClient = ReturnType<typeof createTracedClient>;
