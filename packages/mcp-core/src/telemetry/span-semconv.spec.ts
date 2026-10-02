import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * EXECUTING cover for the edge's semantic-convention span fields:
 * `_shared/telemetry/span-semconv.ts` (pure) and the `otel.ts` code that uses
 * it — DB span naming, parameterised `db.query.text`, `server.address`,
 * `error.type`, and the 5xx `error.type` fallback on the root span.
 *
 * The property that matters is a NEGATIVE one — no filter value reaches any
 * exported attribute or span name — so the DB tests below run a real
 * `createTracedClient` chain with recognisable sentinel values and scan the
 * whole exported OTLP payload for them. A source-scan could not prove that.
 *
 * Both edge modules are reached by a DYNAMIC import over a computed path for
 * the same NX-boundary reason `otel-detached-child.spec.ts` gives: `supabase/`
 * is a separate project, and this is a test reaching across the repo to
 * execute files it does not own.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const telemetryDir = path.join(repoRoot, 'supabase', 'functions', '_shared', 'telemetry');
const load = (file: string) => import(pathToFileURL(path.join(telemetryDir, file)).href);

const semconv = (await load('span-semconv.ts')) as {
  querySummary(op: string, target: string): string;
  conditionSql(column: string, operator: string, value: unknown, negate?: boolean): string | null;
  postgrestLogicToSql(expression: string): string;
  renderStatement(s: {
    op: string; table: string; columns: string; filters: string[]; orderBy?: string; hasLimit: boolean;
  }): string;
  textSearchSql(column: string, type?: string): string;
  resolveServerAddress(clientUrl: unknown, hostedUrl: unknown): string | undefined;
  errorTypeFrom(message: string): string;
  httpRouteFor(functionName: string, routePath: string): string;
};

type Attrs = Record<string, string | number | boolean>;
interface RecordedSpan { name: string; kind: number; attributes: Attrs; status: 'ok' | 'error' }

const otel = (await load('otel.ts')) as {
  Span: new (
    name: string,
    ctx: { traceId: string; spanId: string; sampled: boolean },
    batch: unknown,
    kind?: number,
  ) => {
    error(m: string, t?: string): unknown;
    clientError(m: string, t?: string): unknown;
    end(): void;
  };
  ExportBatch: new () => { drain(): RecordedSpan[] };
  createTracedClient(db: unknown, span: unknown): {
    // deno-style fluent surface; typed loosely, the assertions are on output
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc(fn: string, args?: Record<string, unknown>): any;
  };
  traceRequest(req: Request, op: string, fn: (span: unknown) => Promise<Response>): Promise<Response>;
};

const HOSTED_URL = 'https://pqokxlhvnosogizsjztg.supabase.co';
const ENDPOINT = 'https://otlp.test.invalid';

// ── pure module ─────────────────────────────────────────────────────────────

describe('querySummary (db.query.summary and the DB span name)', () => {
  it('is `<OP> <table>`, and `CALL <fn>` for an RPC', () => {
    expect(semconv.querySummary('SELECT', 'memories')).toBe('SELECT memories');
    expect(semconv.querySummary('UPSERT', 'memories')).toBe('UPSERT memories');
    expect(semconv.querySummary('RPC', 'memory_write')).toBe('CALL memory_write');
  });
});

describe('conditionSql', () => {
  it('renders every value as a placeholder', () => {
    expect(semconv.conditionSql('key', 'eq', 'secret-key')).toBe('key = ?');
    expect(semconv.conditionSql('scope', 'neq', 'x')).toBe('scope <> ?');
    expect(semconv.conditionSql('id', 'in', ['a', 'b'])).toBe('id = ANY(?)');
    expect(semconv.conditionSql('tags', 'cs', '{"a"}')).toBe('tags @> ?');
    expect(semconv.conditionSql('tags', 'ov', ['a'])).toBe('tags && ?');
  });

  it('renders IS keywords literally — they are bounded, not data', () => {
    expect(semconv.conditionSql('archived_at', 'is', null)).toBe('archived_at IS NULL');
    expect(semconv.conditionSql('archived_at', 'is', null, true)).toBe('archived_at IS NOT NULL');
    expect(semconv.conditionSql('flag', 'is', true)).toBe('flag IS TRUE');
    expect(semconv.conditionSql('x', 'is', 'not-a-keyword')).toBe('x IS ?');
  });

  it('negates non-IS operators, maps full-text operators, and strips modifiers', () => {
    expect(semconv.conditionSql('scope', 'eq', 'x', true)).toBe('NOT (scope = ?)');
    expect(semconv.conditionSql('fts', 'wfts(english)', 'q')).toBe('fts @@ websearch_to_tsquery(?)');
    expect(semconv.conditionSql('key', 'like(any)', '{a,b}')).toBe('key LIKE ?');
  });

  it('returns null for an operator it does not know, so the caller redacts', () => {
    expect(semconv.conditionSql('x', 'bogus', 1)).toBeNull();
  });
});

describe('postgrestLogicToSql (the `.or()` argument)', () => {
  it('handles the expiry clause every read path uses', () => {
    expect(semconv.postgrestLogicToSql('expires_at.is.null,expires_at.gt.now()'))
      .toBe('(expires_at IS NULL OR expires_at > ?)');
  });

  it('drops the keyset-cursor values, nested and() included', () => {
    const ts = '2026-10-01T12:34:56.789Z';
    const id = '744e9990-2713-44ac-9e6f-e523ae8bb201';
    const out = semconv.postgrestLogicToSql(`updated_at.lt.${ts},and(updated_at.eq.${ts},id.lt.${id})`);
    expect(out).toBe('(updated_at < ? OR (updated_at = ? AND id < ?))');
    expect(out).not.toContain(ts);
    expect(out).not.toContain(id);
  });

  it('copes with quoted values, commas and braces inside values', () => {
    const out = semconv.postgrestLogicToSql('tags.cs.{"a,b","c}d"},key.in.("x,1","y\\"z"),not.and(scope.eq.repo::o/r,key.is.null)');
    expect(out).toBe('(tags @> ? OR key = ANY(?) OR NOT (scope = ? AND key IS NULL))');
  });

  it('redacts the whole fragment when it cannot vouch for it', () => {
    for (const bad of [
      'key.eq."unterminated',          // unbalanced quote
      'and(key.eq.x',                  // unclosed group
      'key.bogus.secret',              // unknown operator
      'ke y.eq.secret',                // not an identifier
      'justavalue',                    // no operator at all
      '',                              // empty
    ]) {
      const out = semconv.postgrestLogicToSql(bad);
      expect(out, bad).toBe('(?)');
    }
  });
});

describe('renderStatement (db.query.text)', () => {
  it('numbers placeholders in reading order, LIMIT included', () => {
    const sql = semconv.renderStatement({
      op: 'SELECT',
      table: 'memories',
      columns: 'id,scope,value',
      filters: ['key = ?', 'archived_at IS NULL', '(expires_at IS NULL OR expires_at > ?)'],
      orderBy: 'updated_at DESC',
      hasLimit: true,
    });
    expect(sql).toBe(
      'SELECT id,scope,value FROM memories WHERE key = $1 AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY updated_at DESC LIMIT $3',
    );
  });

  it('lists UPDATE columns as assignments and keeps the CALL shape for RPCs', () => {
    expect(semconv.renderStatement({ op: 'UPDATE', table: 'memories', columns: 'archived_at, value', filters: ['id = ?'], hasLimit: false }))
      .toBe('UPDATE memories SET archived_at = $1, value = $2 WHERE id = $3');
    expect(semconv.renderStatement({ op: 'RPC', table: 'memory_write', columns: '', filters: [], hasLimit: true }))
      .toBe('CALL memory_write(...) LIMIT $1');
  });
});

describe('resolveServerAddress', () => {
  it('names the hosted project host', () => {
    expect(semconv.resolveServerAddress(HOSTED_URL, HOSTED_URL)).toBe('pqokxlhvnosogizsjztg.supabase.co');
  });

  it('falls back to the hosted URL when the client URL is unreadable', () => {
    expect(semconv.resolveServerAddress(undefined, HOSTED_URL)).toBe('pqokxlhvnosogizsjztg.supabase.co');
  });

  it('never names a BYOD project — a different host is the user’s infrastructure', () => {
    expect(semconv.resolveServerAddress('https://someone-else.supabase.co', HOSTED_URL)).toBeUndefined();
  });

  it('is undefined when nothing is configured', () => {
    expect(semconv.resolveServerAddress(undefined, undefined)).toBeUndefined();
    expect(semconv.resolveServerAddress('not a url', 'also not')).toBeUndefined();
  });
});

describe('errorTypeFrom', () => {
  it('takes the class / code prefix the edge call sites already write', () => {
    expect(semconv.errorTypeFrom('UserInputError: q is required')).toBe('UserInputError');
    expect(semconv.errorTypeFrom('MethodNotFound: resources/list')).toBe('MethodNotFound');
    expect(semconv.errorTypeFrom('missing_token')).toBe('missing_token');
  });

  it('is _OTHER — never the message — for prose', () => {
    expect(semconv.errorTypeFrom('spec generation failed: boom')).toBe('_OTHER');
    expect(semconv.errorTypeFrom('')).toBe('_OTHER');
    expect(semconv.errorTypeFrom('a'.repeat(80) + ': x')).toBe('_OTHER');
  });
});

describe('httpRouteFor', () => {
  it('joins the mount point and the template in url.path shape', () => {
    expect(semconv.httpRouteFor('memories', '/:id')).toBe('/memories/:id');
    expect(semconv.httpRouteFor('memories', '/usage/runs')).toBe('/memories/usage/runs');
    expect(semconv.httpRouteFor('memories', '/')).toBe('/memories');
  });
});

// ── otel.ts, executed ───────────────────────────────────────────────────────

/** A postgrest-js stand-in: every builder method chains, awaiting resolves. */
function fakeClient(result: { data: unknown; error: unknown }, supabaseUrl?: string) {
  const builder: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
      }
      return () => builder;
    },
  });
  return {
    ...(supabaseUrl ? { supabaseUrl } : {}),
    from: () => builder,
    rpc: () => builder,
  };
}

function newRoot() {
  const batch = new otel.ExportBatch();
  const root = new otel.Span('lorekit.test', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, batch, 2);
  return { root, batch };
}

let hadDeno: boolean;
let env: Record<string, string | undefined>;

beforeEach(() => {
  hadDeno = 'Deno' in globalThis;
  env = { SUPABASE_URL: HOSTED_URL };
  (globalThis as Record<string, unknown>)['Deno'] = { env: { get: (k: string) => env[k] } };
});

afterEach(() => {
  if (!hadDeno) delete (globalThis as Record<string, unknown>)['Deno'];
});

describe('createTracedClient — no filter value reaches telemetry', () => {
  const SECRETS = {
    key: 'reviewer-lessons::sentinel-key-7f3a',
    userId: '6e05fc90-b04b-4e30-b996-7a6248f13a4e',
    search: 'zsh glob sentinel-search-terms',
    tag: 'sentinel-tag',
    cursorTs: '2026-10-01T12:34:56.789Z',
  };

  it('names the span by summary and parameterises the statement', async () => {
    const { root, batch } = newRoot();
    const db = otel.createTracedClient(fakeClient({ data: [{ id: 1 }], error: null }, HOSTED_URL), root);

    await db.from('memories')
      .select('id,key,value,scope,tags,updated_at')
      .eq('user_id', SECRETS.userId)
      .eq('key', SECRETS.key)
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()')
      .or(`updated_at.lt.${SECRETS.cursorTs},and(updated_at.eq.${SECRETS.cursorTs},id.lt.${SECRETS.userId})`)
      .textSearch('fts', SECRETS.search, { type: 'websearch', config: 'english' })
      .contains('tags', [SECRETS.tag])
      .in('scope', ['repo::secret/one', 'repo::secret/two'])
      .order('updated_at', { ascending: false })
      .limit(37);

    const [span] = batch.drain();
    expect(span.name).toBe('SELECT memories');
    expect(span.kind).toBe(3); // CLIENT
    expect(span.attributes['db.query.summary']).toBe('SELECT memories');
    expect(span.attributes['db.collection.name']).toBe('memories');
    expect(span.attributes['db.operation.name']).toBe('SELECT');
    expect(span.attributes['server.address']).toBe('pqokxlhvnosogizsjztg.supabase.co');
    expect(span.attributes['db.query.text']).toBe(
      'SELECT id,key,value,scope,tags,updated_at FROM memories WHERE user_id = $1 AND key = $2 AND archived_at IS NULL'
        + ' AND (expires_at IS NULL OR expires_at > $3) AND (updated_at < $4 OR (updated_at = $5 AND id < $6))'
        + ' AND fts @@ websearch_to_tsquery($7) AND tags @> $8 AND scope = ANY($9) ORDER BY updated_at DESC LIMIT $10',
    );

    // Name + attributes are everything this span exports that a value could
    // ride on (ids and timestamps are excluded: random hex could match).
    const exported = JSON.stringify({ name: span.name, attributes: span.attributes });
    for (const [what, value] of Object.entries({ ...SECRETS, scope: 'repo::secret' })) {
      expect(exported, `${what} leaked into the DB span`).not.toContain(value);
    }
  });

  it('names an RPC `CALL <fn>`', async () => {
    const { root, batch } = newRoot();
    const db = otel.createTracedClient(fakeClient({ data: null, error: null }), root);
    await db.rpc('memory_write', { p_key: SECRETS.key });
    const [span] = batch.drain();
    expect(span.name).toBe('CALL memory_write');
    expect(span.attributes['db.query.text']).toBe('CALL memory_write(...)');
    expect(JSON.stringify({ name: span.name, attributes: span.attributes })).not.toContain(SECRETS.key);
  });

  it('omits server.address for a BYOD client', async () => {
    const { root, batch } = newRoot();
    const db = otel.createTracedClient(fakeClient({ data: [], error: null }, 'https://byod-project.supabase.co'), root);
    await db.from('memories').select('id');
    const [span] = batch.drain();
    // Array form: a dotted string would be read as a nested path and pass vacuously.
    expect(span.attributes).not.toHaveProperty(['server.address']);
    expect(JSON.stringify(span.attributes)).not.toContain('byod-project');
  });

  it('records the SQLSTATE as db.response.status_code and error.type', async () => {
    const { root, batch } = newRoot();
    const db = otel.createTracedClient(
      fakeClient({ data: null, error: { message: 'connection terminated unexpectedly', code: '08006' } }),
      root,
    );
    await db.rpc('memory_delete', {});
    const [span] = batch.drain();
    expect(span.status).toBe('error');
    expect(span.attributes['db.response.status_code']).toBe('08006');
    expect(span.attributes['error.type']).toBe('08006');
  });
});

describe('Span.error / clientError — error.type', () => {
  it('derives the class from the message prefix, or takes an explicit type', () => {
    const { root, batch } = newRoot();
    root.clientError('UserInputError: q is required');
    root.end();
    const derived = new otel.Span('x', { traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), sampled: true }, batch);
    derived.error('Unhandled: boom', 'TypeError');
    derived.end();

    const [client, server] = batch.drain();
    expect(client.attributes['error.type']).toBe('UserInputError');
    expect(client.status).toBe('ok'); // a client error does not flip the status
    expect(server.attributes['error.type']).toBe('TypeError');
    expect(server.status).toBe('error');
  });
});

describe('traceRequest — 5xx error.type fallback', () => {
  let realFetch: typeof globalThis.fetch;
  let posted: string[];

  beforeEach(() => {
    posted = [];
    realFetch = globalThis.fetch;
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] = ENDPOINT;
    globalThis.fetch = ((_url: string, init?: { body?: string }) => {
      posted.push(String(init?.body ?? ''));
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function rootAttrs(status: number, before?: (span: { error(m: string, t?: string): unknown }) => void) {
    await otel.traceRequest(new Request('https://edge.test/memories'), 'lorekit.memories', async (span) => {
      before?.(span as { error(m: string, t?: string): unknown });
      return new Response(null, { status });
    });
    await Promise.resolve();
    const body = JSON.parse(posted.at(-1) as string);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    return Object.fromEntries(
      (span.attributes as Array<{ key: string; value: Record<string, unknown> }>)
        .map((a) => [a.key, Object.values(a.value)[0]]),
    );
  }

  it('records the status code as error.type on an unexplained 5xx', async () => {
    expect((await rootAttrs(503))['error.type']).toBe('503');
  });

  it('keeps the class a handler already named', async () => {
    const attrs = await rootAttrs(500, (span) => span.error('Unhandled: boom', 'TypeError'));
    expect(attrs['error.type']).toBe('TypeError');
  });

  it('sets nothing on a success or a 4xx', async () => {
    expect(await rootAttrs(200)).not.toHaveProperty(['error.type']);
    expect(await rootAttrs(404)).not.toHaveProperty(['error.type']);
  });
});
