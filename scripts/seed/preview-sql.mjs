/**
 * Renders the dataset from `preview-dataset.mjs` into raw SQL statements.
 *
 * Pure and I/O-free — `seed-preview.mjs` is the only caller that actually
 * sends these strings anywhere. Every statement is written to be safe to
 * re-run: memories upsert on `(user_id, scope, key)`, the org/membership rows
 * upsert on their own primary keys, and the two per-memory detail tables
 * (`memory_read_daily`, `memory_citations`) are deleted-then-reinserted for
 * exactly the memory ids this dataset owns, never for anyone else's.
 *
 * No parameterized-query placeholders are available on the two execution
 * channels `seed-preview.mjs` supports (the Supabase Management API's raw SQL
 * endpoint, and a `psql -c`/`-f` fallback for `supabase start`), so every
 * value is escaped and inlined here instead. `sqlString` is the ONE place
 * that happens — never string-interpolate a value directly into a template
 * literal elsewhere in this file.
 */

import { SEED_CORRELATION_PREFIX, SEED_KEY_PREFIX } from './preview-dataset.mjs';

/** Single-quote a string literal, doubling embedded quotes. `null`/`undefined` become SQL NULL. */
export function sqlString(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlBool(value) {
  return value ? 'true' : 'false';
}

export function sqlInt(value) {
  return value === null || value === undefined ? 'null' : String(Math.trunc(value));
}

/** A Postgres `text[]` literal built from `ARRAY[...]`, never the `{...}` shorthand — avoids a second escaping dialect. */
export function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlString).join(', ')}]::text[]`;
}

export function sqlUuidArray(values) {
  return `ARRAY[${values.map(sqlString).join(', ')}]::uuid[]`;
}

/**
 * The org + its single membership row. Both upsert on their real primary
 * keys, so re-running the seed never duplicates either.
 */
export function renderOrgSql(org, userId) {
  return `
insert into orgs (id, slug, name, created_by, created_at, updated_at)
values (${sqlString(org.id)}, ${sqlString(org.slug)}, ${sqlString(org.name)}, ${sqlString(userId)}, now(), now())
on conflict (id) do update set name = excluded.name, updated_at = now();

insert into org_members (org_id, user_id, role, created_at)
values (${sqlString(org.id)}, ${sqlString(userId)}, 'owner', now())
on conflict (org_id, user_id) do nothing;
`.trim();
}

const MEMORY_COLUMNS = [
  'id', 'user_id', 'org_id', 'scope', 'key', 'value', 'tags', 'source_agent', 'trigger',
  'kind', 'host', 'created_at', 'updated_at', 'archived_at', 'expires_at', 'protected',
  'origin_repo', 'origin_branch', 'origin_commit', 'origin_pr',
  'read_count', 'opened_count', 'last_read_at', 'last_opened_at', 'cited_count', 'last_cited_at',
];

function memoryRowSql(m, userId) {
  const values = {
    id: sqlString(m.id),
    user_id: sqlString(userId),
    org_id: sqlString(m.org_id),
    scope: sqlString(m.scope),
    key: sqlString(m.key),
    value: sqlString(m.value),
    tags: sqlTextArray(m.tags),
    source_agent: sqlString(m.source_agent),
    trigger: sqlString(m.trigger),
    kind: sqlString(m.kind),
    host: sqlString(m.host),
    created_at: sqlString(m.created_at),
    updated_at: sqlString(m.updated_at),
    archived_at: sqlString(m.archived_at),
    expires_at: sqlString(m.expires_at),
    protected: sqlBool(m.protected),
    origin_repo: sqlString(m.origin_repo),
    origin_branch: sqlString(m.origin_branch),
    origin_commit: sqlString(m.origin_commit),
    origin_pr: sqlInt(m.origin_pr),
    read_count: sqlInt(m.read_count),
    opened_count: sqlInt(m.opened_count),
    last_read_at: sqlString(m.last_read_at),
    last_opened_at: sqlString(m.last_opened_at),
    cited_count: sqlInt(m.cited_count),
    last_cited_at: sqlString(m.last_cited_at),
  };
  return `(${MEMORY_COLUMNS.map((c) => values[c]).join(', ')})`;
}

/**
 * Bulk upsert every seeded memory in one statement. Conflicts on the table's
 * real unique constraint `(user_id, scope, key)` — safe because every
 * seeded key carries `SEED_KEY_PREFIX`, so it can only ever conflict with a
 * PRIOR run of this same seed, never with real data.
 *
 * Deliberately does NOT touch `created_at` on conflict, so a reseed keeps a
 * memory's original backdated age rather than resetting it to "just now".
 */
export function renderMemoriesSql(memories, userId) {
  if (memories.length === 0) return '-- no memories to seed';
  const rows = memories.map((m) => memoryRowSql(m, userId)).join(',\n  ');
  const updateSet = MEMORY_COLUMNS.filter((c) => !['id', 'user_id', 'created_at'].includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(',\n    ');
  return `
insert into memories (${MEMORY_COLUMNS.join(', ')})
values
  ${rows}
on conflict on constraint memories_user_scope_key_unique do update set
    ${updateSet};
`.trim();
}

/** Delete-then-insert `memory_read_daily` for exactly the memory ids this dataset owns. */
export function renderReadDailySql(readDaily, memoryIds) {
  if (memoryIds.length === 0) return '-- no memories to attach read-daily rows to';
  const del = `delete from memory_read_daily where memory_id = any(${sqlUuidArray(memoryIds)});`;
  if (readDaily.length === 0) return del;
  const rows = readDaily
    .map((r) => `(${sqlString(r.memory_id)}, ${sqlString(r.day)}::date, ${sqlString(r.read_kind)}, ${sqlInt(r.count)})`)
    .join(',\n  ');
  const insert = `
insert into memory_read_daily (memory_id, day, read_kind, count)
values
  ${rows}
on conflict (memory_id, day, read_kind) do update set count = excluded.count;
`.trim();
  return `${del}\n\n${insert}`;
}

/** Delete-then-insert `memory_citations` for exactly the memory ids this dataset owns. */
export function renderCitationsSql(citations, memoryIds, userId) {
  if (memoryIds.length === 0) return '-- no memories to attach citations to';
  const del = `delete from memory_citations where cited_memory_id = any(${sqlUuidArray(memoryIds)});`;
  if (citations.length === 0) return del;
  const rows = citations
    .map((c) => `(${sqlString(userId)}, ${sqlString(c.cited_memory_id)}, null, `
      + `${sqlString(c.correlation_id)}, ${sqlString(c.created_at)})`)
    .join(',\n  ');
  const insert = `
insert into memory_citations (user_id, cited_memory_id, citing_memory_id, correlation_id, created_at)
values
  ${rows};
`.trim();
  return `${del}\n\n${insert}`;
}

/**
 * Delete-then-insert `usage_events` scoped to `SEED_CORRELATION_PREFIX`, for
 * the one `userId` this dataset seeds. Never touches another user's rows —
 * the `user_id` filter is load-bearing here, not the prefix alone.
 */
export function renderUsageEventsSql(usageEvents, userId) {
  const del = `delete from usage_events where user_id = ${sqlString(userId)} and correlation_id like ${sqlString(`${SEED_CORRELATION_PREFIX}-%`)};`;
  if (usageEvents.length === 0) return del;
  const columns = [
    'user_id', 'tool_name', 'scope_type', 'scope', 'scope_count', 'auth_type', 'outcome',
    'duration_ms', 'memory_count', 'result_count', 'correlation_id', 'client', 'kind', 'host',
    'session_kind', 'created_at',
  ];
  const rows = usageEvents
    .map((e) => {
      const values = {
        user_id: sqlString(userId),
        tool_name: sqlString(e.tool_name),
        scope_type: sqlString(e.scope_type),
        scope: sqlString(e.scope),
        scope_count: sqlInt(e.scope_count),
        auth_type: sqlString(e.auth_type),
        outcome: sqlString(e.outcome),
        duration_ms: sqlInt(e.duration_ms),
        memory_count: sqlInt(e.memory_count),
        result_count: sqlInt(e.result_count),
        correlation_id: sqlString(e.correlation_id),
        client: sqlString(e.client),
        kind: sqlString(e.kind),
        host: sqlString(e.host),
        session_kind: sqlString(e.session_kind),
        created_at: sqlString(e.created_at),
      };
      return `(${columns.map((c) => values[c]).join(', ')})`;
    })
    .join(',\n  ');
  const insert = `
insert into usage_events (${columns.join(', ')})
values
  ${rows};
`.trim();
  return `${del}\n\n${insert}`;
}

/**
 * Hard-remove everything a previous run of this seed left behind, for one
 * user: every `SEED_KEY_PREFIX`-keyed memory (cascades to its
 * `memory_read_daily`/`memory_citations` rows via FK `on delete cascade`),
 * every `SEED_CORRELATION_PREFIX`-prefixed usage event, and the seed org
 * (cascades to its membership row and reverts any org-owned seed memory to
 * personal — moot here since those rows are deleted in the same statement).
 *
 * Used by `--reset` before reseeding, and is exactly what makes a reseed with
 * a CHANGED dataset shape (a template renamed or removed) converge instead of
 * accumulating orphaned rows the upsert path can't reach.
 *
 * The org delete is also scoped to `created_by = userId` — the org id is a
 * fixed constant shared by every seed run, so without this filter one user's
 * `--reset` would drop the shared preview org (and cascade its membership row)
 * out from under whichever user actually created it.
 */
export function renderResetSql(org, userId) {
  return `
delete from memories where user_id = ${sqlString(userId)} and key like ${sqlString(`${SEED_KEY_PREFIX}%`)};
delete from usage_events where user_id = ${sqlString(userId)} and correlation_id like ${sqlString(`${SEED_CORRELATION_PREFIX}-%`)};
delete from orgs where id = ${sqlString(org.id)} and created_by = ${sqlString(userId)};
`.trim();
}
