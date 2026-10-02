// Pure, import-free helpers that turn what an edge request did into
// semantic-convention span fields WITHOUT copying caller data into them.
//
// WHY THIS EXISTS
// `TracedQuery` used to interpolate every filter VALUE into both the DB span's
// name and its `db.query.text`:
//
//   SELECT id,scope,value FROM memories WHERE key = 'reviewer-lessons::…' …
//   SELECT … FROM memories WHERE fts @@ to_tsquery('zsh glob no matches …')
//   SELECT plan_name FROM user_plans WHERE user_id = '6e05fc90-…' LIMIT 1
//
// That made the `api` service emit 511 distinct span names in one week (287 of
// them carrying full-text search terms, 133 memory keys, 4 user UUIDs). A span
// name is a GROUPING key, so every one of those is a separate operation in the
// trace explorer; and `db.query.text` is defined by the OTel database
// conventions as the parameterised / sanitised statement, not the literal one.
// The search terms are the sharpest case: the CLI hook distils them from an
// agent's tool-failure text and deliberately keeps that text out of its OWN
// telemetry, and the server then wrote it into span names anyway.
//
// So the rule here is: identifiers that come from OUR code (table, columns,
// operators, function names) are rendered; every value is a `$n` placeholder.
// When a filter string cannot be parsed, the whole fragment collapses to a
// placeholder — the failure mode is "less detail", never "leaked a value".
//
// Import-free on purpose, so the mcp-core vitest suite can load and execute it
// directly (see `packages/mcp-core/src/telemetry/span-semconv.spec.ts`), the
// same cross-tree pattern `otel-detached-child.spec.ts` uses for `otel.ts`.

export type DbOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT' | 'RPC';

/**
 * The placeholder a filter fragment carries for a value. Numbered to `$1…$n`
 * only when the whole statement is rendered, so fragments can be built in any
 * order. Safe as a sentinel because no fragment ever contains caller text —
 * only identifiers and SQL operators, none of which use `?`.
 */
const PARAM = '?';

/** A plain SQL identifier — the only shape a column name may take in output. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Bounded, low-cardinality summary of a DB call: `{operation} {target}`.
 *
 * This is OTel's `db.query.summary` and, per the conventions, the DB span's
 * NAME. A stored-procedure call reads `CALL <function>` (the vocabulary the
 * previous `CALL fn(...)` names already used), every other operation reads
 * `<OP> <table>`.
 */
export function querySummary(op: DbOperation, target: string): string {
  return op === 'RPC' ? `CALL ${target}` : `${op} ${target}`;
}

const COMPARISON_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  match: '~',
  imatch: '~*',
  isdistinct: 'IS DISTINCT FROM',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxl: '&<',
  nxr: '&>',
  adj: '-|-',
};

const TEXT_SEARCH_FN: Record<string, string> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
};

/** The keyword-like values `IS` accepts. Bounded, so rendering them leaks nothing. */
const IS_LITERALS = new Set(['null', 'true', 'false', 'unknown']);

/**
 * The tsquery constructor a postgrest-js `textSearch(…, { type })` call maps
 * to. Mirrors postgrest-js: no type is plain `to_tsquery`.
 */
export function textSearchFunction(type?: string): string {
  if (type === 'plain') return 'plainto_tsquery';
  if (type === 'phrase') return 'phraseto_tsquery';
  if (type === 'websearch') return 'websearch_to_tsquery';
  return 'to_tsquery';
}

/** `col @@ <fn>(?)` for a full-text filter. */
export function textSearchSql(column: string, type?: string): string {
  return `${column} @@ ${textSearchFunction(type)}(${PARAM})`;
}

/**
 * Render ONE filter as SQL with a placeholder for its value.
 *
 * `operator` is a PostgREST operator (`eq`, `in`, `is`, `cs`, `fts(english)`,
 * `like(any)`, …). `value` is inspected for exactly one purpose — whether an
 * `is` filter compares against a keyword (`null`/`true`/`false`/`unknown`),
 * which is rendered literally because it is a bounded keyword, not data.
 *
 * Returns `null` for an operator it does not know, so the caller can redact
 * rather than guess.
 */
export function conditionSql(column: string, operator: string, value: unknown, negate = false): string | null {
  // `fts(english)` / `like(any)` carry a modifier in parentheses; it changes
  // HOW the value is matched, not what the operator is.
  const op = operator.replace(/\(.*\)$/, '').toLowerCase();

  if (op === 'is') {
    const keyword = String(value).toLowerCase();
    const rhs = IS_LITERALS.has(keyword) ? keyword.toUpperCase() : PARAM;
    return `${column} IS ${negate ? 'NOT ' : ''}${rhs}`;
  }

  let body: string | null = null;
  if (op === 'in') body = `${column} = ANY(${PARAM})`;
  else if (op in TEXT_SEARCH_FN) body = `${column} @@ ${TEXT_SEARCH_FN[op]}(${PARAM})`;
  else if (op in COMPARISON_SQL) body = `${column} ${COMPARISON_SQL[op]} ${PARAM}`;
  if (body === null) return null;

  return negate ? `NOT (${body})` : body;
}

// ── PostgREST logic-tree strings (`.or()`) ─────────────────────────────────

class LogicParseError extends Error {}

/**
 * Sanitise a PostgREST logic-tree filter string — the argument postgrest-js
 * `.or()` takes, e.g.
 *
 *   expires_at.is.null,expires_at.gt.now()
 *   updated_at.lt.2026-10-01T…,and(updated_at.eq.2026-10-01T…,id.lt.4f1c…)
 *   tags.cs.{"a,b"},key.in.("x","y")
 *
 * into a parenthesised SQL fragment with every value replaced by a placeholder:
 *
 *   (expires_at IS NULL OR expires_at > ?)
 *
 * The top level is OR-joined, because that is what `.or()` means. TOTAL: any
 * input the parser does not understand — an unknown operator, a column that is
 * not a plain identifier, unbalanced quoting — returns `(?)`. The point of the
 * parse is to keep values OUT; a fragment it cannot vouch for is dropped whole.
 */
export function postgrestLogicToSql(expression: string): string {
  try {
    const parser = new LogicParser(expression);
    const parts = parser.conditions();
    if (!parser.done()) throw new LogicParseError('trailing input');
    return `(${parts.join(' OR ')})`;
  } catch {
    return `(${PARAM})`;
  }
}

class LogicParser {
  private i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  /** A comma-separated list of conditions, up to the end or a closing `)`. */
  conditions(): string[] {
    const out = [this.condition()];
    while (this.s[this.i] === ',') {
      this.i++;
      out.push(this.condition());
    }
    return out;
  }

  private condition(): string {
    const group = /^(not\.)?(and|or)\(/.exec(this.s.slice(this.i));
    if (group) {
      this.i += group[0].length;
      const inner = this.conditions();
      if (this.s[this.i] !== ')') throw new LogicParseError('unclosed group');
      this.i++;
      const joined = `(${inner.join(group[2] === 'and' ? ' AND ' : ' OR ')})`;
      return group[1] ? `NOT ${joined}` : joined;
    }

    const column = this.segment();
    if (!IDENTIFIER.test(column)) throw new LogicParseError('column is not an identifier');
    let operator = this.segment();
    let negate = false;
    if (operator === 'not') {
      negate = true;
      operator = this.segment();
    }
    const value = this.value();
    const sql = conditionSql(column, operator, value, negate);
    if (sql === null) throw new LogicParseError('unknown operator');
    return sql;
  }

  /** Text up to the next `.` (consumed). An operator may carry a `(modifier)`. */
  private segment(): string {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) throw new LogicParseError('segment ended early');
        depth--;
      } else if (depth === 0 && c === '.') break;
      else if (depth === 0 && c === ',') throw new LogicParseError('segment ended early');
      this.i++;
    }
    if (this.s[this.i] !== '.') throw new LogicParseError('expected "."');
    const seg = this.s.slice(start, this.i);
    this.i++; // the '.'
    return seg;
  }

  /**
   * A value, up to the next top-level `,` or `)`. Values may be double-quoted
   * (with `\"` escapes), or bracketed — `(a,b)` for `in`, `{a,b}` for array
   * operators — and may contain dots (timestamps, decimals). Returned raw; the
   * caller only ever inspects it for an `IS` keyword.
   */
  private value(): string {
    const start = this.i;
    let depth = 0;
    let quoted = false;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (quoted) {
        if (c === '\\') this.i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      this.i++;
    }
    if (quoted || depth !== 0) throw new LogicParseError('unbalanced value');
    return this.s.slice(start, this.i);
  }
}

// ── statement rendering ────────────────────────────────────────────────────

export interface StatementShape {
  op: DbOperation;
  table: string;
  /** Column list as written by our code (`'id,key,value'`, `Object.keys(row)`). */
  columns: string;
  /** Fragments built by `conditionSql` & co. — placeholders only, never values. */
  filters: readonly string[];
  orderBy?: string;
  hasLimit: boolean;
  /** A mutation's `.select(...)` columns, rendered as `RETURNING …`. */
  returning?: string;
}

/**
 * The parameterised statement for `db.query.text`.
 *
 * Placeholders are numbered `$1…$n` in reading order, which is how Postgres
 * itself writes a prepared statement. The `LIMIT` is a placeholder too: it is
 * often the caller's own `limit` argument, and a literal would split one call
 * site into a statement per page size.
 */
export function renderStatement(s: StatementShape): string {
  const parts: string[] = [];
  const cols = s.columns.trim();
  switch (s.op) {
    case 'SELECT': parts.push(`SELECT ${cols || '*'} FROM ${s.table}`); break;
    case 'INSERT': parts.push(`INSERT INTO ${s.table}${cols ? ` (${cols})` : ''}`); break;
    case 'UPDATE': parts.push(`UPDATE ${s.table} SET ${setList(cols)}`); break;
    case 'DELETE': parts.push(`DELETE FROM ${s.table}`); break;
    case 'UPSERT': parts.push(`UPSERT INTO ${s.table}${cols ? ` (${cols})` : ''}`); break;
    case 'RPC': parts.push(`CALL ${s.table}(...)`); break;
  }
  if (s.filters.length) parts.push(`WHERE ${s.filters.join(' AND ')}`);
  if (s.orderBy) parts.push(`ORDER BY ${s.orderBy}`);
  if (s.hasLimit) parts.push(`LIMIT ${PARAM}`);
  const mutates = s.op === 'INSERT' || s.op === 'UPDATE' || s.op === 'UPSERT' || s.op === 'DELETE';
  if (mutates && s.returning?.trim()) parts.push(`RETURNING ${s.returning.trim()}`);

  let n = 0;
  return parts.join(' ').replace(/\?/g, () => `$${++n}`);
}

/** `a = ?, b = ?` from an UPDATE's column list; `...` when it is unknown. */
function setList(columns: string): string {
  const names = columns.split(',').map((c) => c.trim()).filter((c) => IDENTIFIER.test(c));
  return names.length ? names.map((c) => `${c} = ${PARAM}`).join(', ') : '...';
}

// ── server.address ─────────────────────────────────────────────────────────

/** Hostname of a URL-ish value, or `undefined` when it is not one. */
function hostOf(url: unknown): string | undefined {
  if (url === undefined || url === null || url === '') return undefined;
  try {
    return new URL(String(url)).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `server.address` for a traced DB call: the PostgREST host the client talks
 * to — but ONLY when that is LoreKit's own hosted project.
 *
 * `clientUrl` is the URL the supabase-js client was built with; `hostedUrl` is
 * the function's `SUPABASE_URL`. A client pointed somewhere else is a BYOD
 * storage adapter talking to a USER'S OWN Supabase project, and that project's
 * host is the user's infrastructure, not ours to put in telemetry — so it is
 * omitted rather than named. When the client's URL cannot be read (a test
 * double), the hosted URL is the only project the function knows, and it is
 * used.
 */
export function resolveServerAddress(clientUrl: unknown, hostedUrl: unknown): string | undefined {
  const hosted = hostOf(hostedUrl);
  const client = hostOf(clientUrl);
  if (client === undefined) return hosted;
  return client === hosted ? client : undefined;
}

// ── error.type ─────────────────────────────────────────────────────────────

/** The `error.type` fallback when nothing more specific is known (OTel's own). */
export const ERROR_TYPE_OTHER = '_OTHER';

/**
 * A bounded `error.type` from an error message of the shape every edge call
 * site already uses — `ClassName: detail` (`UserInputError: q is required`,
 * `MethodNotFound: resources/list`) or a bare code (`missing_token`).
 *
 * Anything else — prose with spaces before the colon, an empty message — is
 * `_OTHER`, never the message itself: `error.type` is a grouping key, and the
 * free text already rides on `error.message`.
 */
export function errorTypeFrom(message: string): string {
  const m = /^([A-Za-z_][A-Za-z0-9_.]{0,63})(?::|$)/.exec(message.trim());
  return m ? m[1] : ERROR_TYPE_OTHER;
}

// ── http.route ─────────────────────────────────────────────────────────────

/**
 * `http.route` for a router-matched edge request: the function's mount point
 * plus the route TEMPLATE, in the same shape `url.path` reports
 * (`/memories/:id`, never `/memories/744e…`). The index route is the bare
 * mount point (`/memories`), matching what a caller actually requests.
 */
export function httpRouteFor(functionName: string, routePath: string): string {
  const tail = routePath === '/' ? '' : routePath;
  return `/${functionName}${tail}`;
}
