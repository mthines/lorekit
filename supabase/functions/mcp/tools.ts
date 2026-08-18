/**
 * MCP tool handlers — one function per memory.* and org.* tool.
 *
 * SECURITY: When userId is provided (api_key auth), every query MUST include
 * .eq('user_id', userId). The service-role client bypasses RLS — without this
 * filter, users could access each other's memories.
 *
 * org.* tools REQUIRE a Supabase user JWT (auth.uid() is resolved inside the
 * SECURITY DEFINER RPCs on the server). They are NOT accessible via api_key
 * auth because the RPCs use auth.uid() — a service-role client has no session
 * JWT and therefore no auth.uid(). Callers with api_key tokens receive a
 * -32001 PermissionDenied response.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope, UserInputError } from '../_shared/scope.ts';
import { createTracedClient, type Span } from '../_shared/otel.ts';
import { translateCapError } from './limits.ts';
import { translateOrgPermissionError } from './org-permissions.ts';
import { parseCreatedAt } from '../_shared/created-at.ts';
import { parseTtl } from './ttl.ts';
import { parseOrigin } from '../_shared/origin.ts';
import { recordAudit } from '../_shared/audit.ts';
import { applyTenantScope, type KeyRestriction } from '../_shared/tenant-scope.ts';
import { decodeCursor, buildPage } from './cursor.ts';
import { resolveKindHost } from '../_shared/schemas/tags.ts';
import { rankLessons, selectDiverse } from '../_shared/lesson-rank.ts';
import type { RankableLesson } from '../_shared/lesson-rank.ts';
import { outcomeFromTags } from '../_shared/outcome-signal.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

/**
 * Characters of `value` echoed in a `view: "summary"` entry's `preview`.
 *
 * Declared locally rather than imported, following the `MAX_VALUE_BYTES` /
 * `PURGE_RETENTION_DAYS_DEFAULT` precedent directly above: this file is
 * self-contained Deno and the authoritative declaration is
 * `packages/schemas/src/memory.ts` (`LIST_PREVIEW_CHARS`), kept honest by
 * `packages/mcp-core/src/list-view-parity.spec.ts`.
 */
const LIST_PREVIEW_CHARS = 200;

/** A list row as selected from Postgres, before the `view` projection. */
interface ListRow {
  id?: string;
  key: string;
  value: string;
  tags: string[];
  updated_at: string | null;
}

/**
 * Project a list row for the wire.
 *
 * `full` passes the row through unchanged — the historical shape, so no
 * existing caller sees a difference. `summary` swaps the body for its size and
 * a bounded prefix, which is what makes a 50-entry discovery read affordable:
 * an entry drops from ~1.9 KB to ~250 bytes, and the caller follows up with
 * `memory.read` only for the keys it actually matched.
 *
 * `value_bytes` is the BYTE length (via TextEncoder), not `String.length` —
 * the number is meant to be comparable with `MAX_VALUE_BYTES`, which is also
 * bytes, and a multi-byte body would otherwise under-report.
 *
 * `preview` slices `[...value]`, NOT `value.slice()`. String indices are UTF-16
 * code units, so cutting at a fixed index can land between a surrogate pair and
 * emit a lone half — an unpaired surrogate is not valid UTF-8 and survives a
 * JSON round-trip as U+FFFD. Spreading iterates code points, so an emoji or a
 * non-BMP character is either whole or absent.
 */
function projectListEntry(row: ListRow, summarize: boolean) {
  if (!summarize) return row;
  const { value, ...rest } = row;
  return {
    ...rest,
    value_bytes: new TextEncoder().encode(value ?? '').length,
    preview: [...(value ?? '')].slice(0, LIST_PREVIEW_CHARS).join(''),
  };
}

/**
 * How many rows the ranked path fetches before scoring. Mirrors the same
 * constant in `memories/handlers/relevant.ts` — see its docblock for the
 * rationale and the honest "recency-windowed ranking" caveat.
 *
 * Bounded because the cost is real (every candidate is fetched and mostly
 * discarded). 200 is well above any `limit` this tool accepts (max 100) while
 * staying one cheap indexed read.
 */
const CANDIDATE_LIMIT = 200;

// deno-lint-ignore no-explicit-any
export type Params = Record<string, any>;

/**
 * Resolve the org ids a user is a member of via the single membership-truth
 * RPC (lorekit_member_org_ids, 00014_orgs.sql) — never re-derives membership
 * itself. Used only by the api_key read handlers below; the JWT/dashboard
 * path gets identical widening for free through RLS (00015_memories_org_fk.sql).
 *
 * Fails closed: an RPC error resolves to no orgs (personal-only), never to
 * broader access than intended.
 *
 * Performance: the result is memoised per-request via a module-level WeakMap
 * keyed by the db client instance (which is created once per request in
 * auth.ts → getDb). This avoids a redundant RPC round-trip when multiple
 * read tools are called in the same request (toolRead + toolSearch, etc.).
 */
const memberOrgIdsCache = new WeakMap<object, Map<string, string[]>>();

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  // Retrieve or create the per-client cache map.
  let clientCache = memberOrgIdsCache.get(db as object);
  if (!clientCache) {
    clientCache = new Map();
    memberOrgIdsCache.set(db as object, clientCache);
  }

  const cached = clientCache.get(userId);
  if (cached !== undefined) return cached;

  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  const result = error ? [] : ((data ?? []) as string[]);
  clientCache.set(userId, result);
  return result;
}

export async function toolWrite(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger, created_at, org, ttl_days, ttl_minutes, ttl_seconds, clear_ttl = false, origin_repo, origin_branch, origin_commit, origin_pr, kind, host } = params;
  if (!rawScope || !key || !value) throw new Error('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  const scope = validateScope(rawScope);
  // Optional creation-date override (migration use case). Validates + rejects
  // future dates; null when omitted so the DB applies its now() default.
  const createdAt = parseCreatedAt(created_at);
  const ttlSeconds = parseTtl({ ttl_days, ttl_minutes, ttl_seconds });
  // Optional provenance: where the write happened (repo / branch / commit / PR).
  // Every field is independently optional; the RPC keeps the last KNOWN value
  // per field, so omitting one never erases what an earlier write recorded.
  const origin = parseOrigin({ origin_repo, origin_branch, origin_commit, origin_pr });
  // Taxonomy: explicit kind/host win; otherwise recover them from the loop tag.
  // The shared resolver is the one place the closed-vocabulary check and the
  // host-length clamp live, so storage and usage tracking classify identically.
  const { kind: resolvedKind, host: resolvedHost } = resolveKindHost({ kind, host, tags });

  span.setAttributes({
    'lorekit.scope': scope,
    'lorekit.key': key,
    'lorekit.value.bytes': value.length,
    'lorekit.tags.count': tags.length,
    ...(source_agent ? { 'lorekit.source_agent': source_agent } : {}),
    ...(trigger ? { 'lorekit.trigger': trigger } : {}),
    ...(createdAt ? { 'lorekit.created_at': createdAt } : {}),
    ...(org ? { 'lorekit.org': org } : {}),
    ...(ttlSeconds !== null ? { 'lorekit.ttl_seconds': ttlSeconds } : {}),
    ...(clear_ttl ? { 'lorekit.clear_ttl': true } : {}),
    ...(origin.repo ? { 'lorekit.origin.repo': origin.repo } : {}),
    ...(origin.branch ? { 'lorekit.origin.branch': origin.branch } : {}),
    ...(origin.commit ? { 'lorekit.origin.commit': origin.commit } : {}),
    ...(origin.pr !== null ? { 'lorekit.origin.pr': origin.pr } : {}),
    ...(resolvedKind ? { 'lorekit.kind': resolvedKind } : {}),
    ...(resolvedHost ? { 'lorekit.host': resolvedHost } : {}),
  });

  // 00003 replaced the plain unique constraint with PARTIAL indexes
  // (WHERE archived_at IS NULL), which `.upsert(onConflict)` cannot target.
  // The memory_write RPC (00007) performs the correct partial-index upsert,
  // branching on whether user_id is null.
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('memory_write', {
      p_user_id: userId,
      p_scope: scope,
      p_key: key,
      p_value: value,
      p_tags: tags,
      p_source_agent: source_agent ?? null,
      p_trigger: trigger ?? null,
      p_created_at: createdAt,
      p_org_slug: org ?? null,
      p_ttl_seconds: ttlSeconds,
      p_clear_ttl: clear_ttl,
      p_origin_repo: origin.repo,
      p_origin_branch: origin.branch,
      p_origin_commit: origin.commit,
      p_origin_pr: origin.pr,
      p_kind: resolvedKind,
      p_host: resolvedHost,
      // The calling key's restriction, BOTH axes (00068/00069). The RPC is the
      // LAST gate on the write path — the edge runs on the service-role client,
      // so the dispatcher's check above it is advisory — and it is also the only
      // place that can see the scope→org BINDING, which must not route a
      // restricted key's write into an org it was never granted.
      p_key_scopes: keyScoping?.scopes ?? [],
      p_key_org_access: keyScoping?.orgAccess ?? 'all',
      p_key_org_ids: keyScoping?.orgIds ?? [],
    })
    .single();
  if (error) {
    const translated = translateOrgPermissionError(translateCapError(error));
    throw translated instanceof Error ? translated : new Error(error.message);
  }
  const row = data as {
    id: string;
    created_at: string;
    inserted?: boolean;
    org_routed?: boolean;
    binding_org_slug?: string | null;
  };

  // Emit the write outcome as a telemetry attribute (insert vs update) so
  // dashboards can distinguish new memory creation from updates without reading
  // the audit_log table.
  span.setAttributes({ 'lorekit.write.inserted': row.inserted !== false });

  await recordAudit(
    db,
    {
      action: row.inserted === false ? 'memory.update' : 'memory.create',
      resourceType: 'memory',
      resourceId: row.id,
      target: key,
      metadata: { scope, key },
    },
    userId,
  );
  // `inserted` is an internal audit-classification signal (D4), not part of
  // the memory.write response contract — keep the same {id, created_at}
  // shape the Node (mcp-core) path returns so both production surfaces agree.
  if (row.binding_org_slug && row.org_routed === false) {
    return {
      id: row.id,
      created_at: row.created_at,
      notice: `Saved to your personal lore. The scope "${scope}" is shared with the "${row.binding_org_slug}" organization, but you're not a write-member — ask an admin to add you to share it with the team.`,
    };
  }
  const result: Record<string, unknown> = { id: row.id, created_at: row.created_at };
  if (ttlSeconds !== null || clear_ttl) result.expires_at = (row as { id: string; created_at: string; expires_at?: string | null }).expires_at ?? null;
  return result;
}

export async function toolRead(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb.from('memories').select('value,updated_at').eq('scope', scope).eq('key', key).is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function toolList(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, tags, limit = 50, cursor: cursorParam, kind, host } = params;
  if (!rawScope) throw new Error('scope is required');
  const scope = validateScope(rawScope);
  const pageLimit = Math.min(limit, 100);

  // Validate `kind` against the same closed 3-value vocabulary the catalog
  // `enum` and `MemoryKindSchema` accept, for the same reason `order` is
  // validated below: a present-but-invalid value must be REJECTED, not
  // silently ignored, or a caller typo turns into an unfiltered full-scope
  // read that looks like it worked.
  if (kind !== undefined && kind !== 'lesson' && kind !== 'bus' && kind !== 'signal') {
    throw new UserInputError(`Invalid kind "${kind}": expected "lesson", "bus" or "signal"`);
  }
  if (host !== undefined && (typeof host !== 'string' || host.length === 0 || host.length > 64)) {
    throw new UserInputError('Invalid host: expected a non-empty string of at most 64 characters');
  }

  // `view` decides how much of each entry reaches the wire, NOT what is read
  // from Postgres. `value` is still selected in summary mode because the
  // ranked path scores and MMR-diversifies on the body text — dropping it from
  // the query would change WHICH rows come back, not just how fat they are.
  if (params.view !== undefined && params.view !== 'full' && params.view !== 'summary') {
    throw new UserInputError(`Invalid view "${params.view}": expected "full" or "summary"`);
  }
  const summarize = params.view === 'summary';

  // Validate `order` against the same closed set the catalog `enum` and
  // `MemoryListSchema` accept ('recency' | 'rank'). A present-but-invalid value
  // (e.g. `"Rank"`) must be REJECTED, not silently coerced to recency — a quiet
  // fallthrough would mask a caller typo and diverge from the schema contract.
  // `undefined` means "unspecified" and defaults to recency (D3).
  if (params.order !== undefined && params.order !== 'recency' && params.order !== 'rank') {
    throw new UserInputError(`Invalid order "${params.order}": expected "recency" or "rank"`);
  }
  const ranked = params.order === 'rank';

  span.setAttributes({ 'lorekit.scope': scope });

  const tracedDb = createTracedClient(db, span);

  if (ranked) {
    // ── Ranked path (D1/D2/D4/D8) ─────────────────────────────────────────
    // Mirrors `memories/handlers/relevant.ts`: fetch a bounded candidate window
    // (updated_at desc), rank in TypeScript via the shared edge rankLessons,
    // return a bounded top-N page. No cursor decode (D7 — cursor is ignored).
    // seen_count is selected here and dropped from the wire response (D4).
    let rankQuery = tracedDb
      .from('memories')
      .select('id,key,value,tags,updated_at,seen_count,origin_pr')
      .eq('scope', scope)
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CANDIDATE_LIMIT);
    if (userId) rankQuery = applyTenantScope(rankQuery, userId, await memberOrgIds(db, userId), keyScoping);
    if (tags?.length) rankQuery = rankQuery.overlaps('tags', tags);
    // Taxonomy filters are applied BEFORE ranking, not after: the candidate
    // window is bounded at CANDIDATE_LIMIT, so filtering afterwards would rank
    // over a window that a prolific other bucket could have already filled.
    if (kind) rankQuery = rankQuery.eq('kind', kind);
    if (host) rankQuery = rankQuery.eq('host', host);
    const { data: rankData, error: rankError } = await rankQuery;
    if (rankError) throw new Error(rankError.message);

    const candidates: (RankableLesson & { id: string; key: string; value: string; tags: string[]; updated_at: string | null })[] = (rankData ?? []).map(
      // deno-lint-ignore no-explicit-any
      (r: any) => ({
        id: r.id,
        key: r.key,
        value: r.value,
        tags: r.tags,
        updated_at: r.updated_at,
        seen_count: r.seen_count,
        outcome: outcomeFromTags(r.tags, r.origin_pr),
      }),
    );

    const rankedLessons = rankLessons(candidates, { now: Date.now() });
    // NOTE: `selectDiverse` applies MMR diversification, which REORDERS the page.
    // The returned rows are therefore NO LONGER monotonically descending by
    // score — a lower-scored but more diverse lesson can precede a higher-scored
    // near-duplicate. Consumers of `order=rank` must not assume score-monotonic
    // output; the tool-catalog `order` description (tool-catalog.ts) says so too.
    const page = selectDiverse(rankedLessons, pageLimit);

    const entries = page.map(({ entry }) =>
      projectListEntry(
        {
          id: entry.id,
          key: entry.key,
          value: entry.value,
          tags: entry.tags,
          updated_at: entry.updated_at,
        },
        summarize,
      ),
    );

    // `candidate_count` saturates at CANDIDATE_LIMIT — mirrors the observability
    // `memories/handlers/relevant.ts` exposes so a truncated window is visible in
    // telemetry (a `candidate_count === CANDIDATE_LIMIT` read may have ranked over
    // a windowed subset). `result.count` is the post-`limit` page size.
    span.setAttributes({
      'lorekit.result.count': entries.length,
      'lorekit.candidate_count': candidates.length,
    });
    // `hasMore` is FALSE here by contract, not by accident. Everywhere else in
    // this codebase `hasMore: true` means "there is another page, and
    // `nextCursor` is how you reach it" (`cursor.ts` buildPage,
    // `_shared/api/paginate.ts`). Ranked mode has no cursor, so a `true` would
    // promise a page no caller can ever fetch. A ranked read is a single
    // bounded top-N over a CANDIDATE_LIMIT window — the same shape as
    // `memories/handlers/relevant.ts`, which likewise never advertises
    // pagination. Truncation is inherent to the mode and documented on the
    // tool, not signalled per response.
    return { entries, hasMore: false, nextCursor: null };
  }

  // ── Recency path (default) — UNCHANGED ──────────────────────────────────
  let query = tracedDb
    .from('memories')
    .select('id,key,value,tags,updated_at')
    .eq('scope', scope)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageLimit + 1);
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  if (tags?.length) query = query.overlaps('tags', tags);
  if (kind) query = query.eq('kind', kind);
  if (host) query = query.eq('host', host);
  // Apply cursor keyset predicate when a valid cursor is supplied.
  const decoded = cursorParam ? decodeCursor(cursorParam) : null;
  if (decoded && decoded.sort === 'updated_at') {
    query = query.or(`updated_at.lt.${decoded.ts},and(updated_at.eq.${decoded.ts},id.lt.${decoded.id})`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  // Page BEFORE projecting: `buildPage` decides `hasMore`/`nextCursor` from the
  // pageLimit+1 sentinel row and keys the cursor off `updated_at`+`id`, both of
  // which survive the projection — but it must see the raw row set to do it.
  const page = buildPage(rows, pageLimit, 'updated_at');
  span.setAttributes({ 'lorekit.result.count': page.entries.length });
  return {
    ...page,
    entries: (page.entries as ListRow[]).map((row) => projectListEntry(row, summarize)),
  };
}

/**
 * Delete a memory.
 *
 * Default (force: false): soft-archive — sets archived_at, hides from normal
 * reads, recoverable via memory.restore, purged after retention_days (default 30).
 *
 * With force: true: immediate hard-delete, unrecoverable.
 */
export async function toolDelete(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key, force = false, org } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({
    'lorekit.scope': scope,
    'lorekit.key': key,
    'lorekit.delete.force': force,
    ...(org ? { 'lorekit.org': org } : {}),
  });

  const tracedDb = createTracedClient(db, span);

  if (org) {
    // Org-owned delete: role-gated inside the memory_delete RPC (SECURITY
    // DEFINER) — never a raw service-role .delete()/.update(), which would
    // bypass the role gate entirely since this client bypasses RLS.
    const { data, error } = await tracedDb
      .rpc('memory_delete', {
        p_user_id: userId,
        p_org_slug: org,
        p_scope: scope,
        p_key: key,
        p_force: force,
        // The calling key's restriction (00068/00069). This RPC picks its own
        // rows, so there is no query for the transport to filter, and the
        // dispatcher's refusal runs on the service-role client and is advisory
        // — without these the org branch enforced the owner's ROLE and nothing
        // about the key.
        p_key_scopes: keyScoping?.scopes ?? [],
        p_key_org_access: keyScoping?.orgAccess ?? 'all',
        p_key_org_ids: keyScoping?.orgIds ?? [],
      })
      .single();
    if (error) {
      const translated = translateOrgPermissionError(error);
      throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
    }
    const row = data as { deleted: boolean; archived: boolean };
    span.setAttributes({ 'lorekit.result.deleted': row.deleted, 'lorekit.result.archived': row.archived });
    if (row.deleted || row.archived) {
      await recordAudit(
        db,
        {
          action: row.deleted ? 'memory.delete' : 'memory.archive',
          resourceType: 'memory',
          target: key,
          metadata: { scope, key, force, org },
        },
        userId,
      );
    }
    return { deleted: row.deleted, archived: row.archived };
  }

  if (force) {
    let query = tracedDb.from('memories').delete({ count: 'exact' }).eq('scope', scope).eq('key', key);
    if (userId) query = query.eq('user_id', userId);
    const { error, count } = await query;
    if (error) throw new Error(error.message);
    const deleted = (count ?? 0) > 0;
    span.setAttributes({ 'lorekit.result.deleted': deleted, 'lorekit.result.archived': false });
    if (deleted) {
      await recordAudit(
        db,
        { action: 'memory.delete', resourceType: 'memory', target: key, metadata: { scope, key, force: true } },
        userId,
      );
    }
    return { deleted, archived: false };
  }

  let query = tracedDb
    .from('memories')
    .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
    .eq('scope', scope)
    .eq('key', key)
    .is('archived_at', null);
  if (userId) query = query.eq('user_id', userId);
  const { error, count } = await query;
  if (error) throw new Error(error.message);
  const archived = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.deleted': false, 'lorekit.result.archived': archived });
  if (archived) {
    await recordAudit(
      db,
      { action: 'memory.archive', resourceType: 'memory', target: key, metadata: { scope, key, force: false } },
      userId,
    );
  }
  return { deleted: false, archived };
}

export async function toolSearch(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { q, scopes, tags, limit = 20, cursor: cursorParam } = params;
  if (!q) throw new Error('q is required');
  const pageLimit = Math.min(limit, 100);

  span.setAttributes({ 'lorekit.search.query': q });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('id,key,value,scope,tags,updated_at')
    .textSearch('fts', q, { type: 'websearch', config: 'english' })
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageLimit + 1);
  // Tenant .or() and the scope-glob .or() below are applied as two separate
  // .or() calls, which PostgREST ANDs together — never merged into one
  // filter (see tenant-scope.ts and the Edge Cases note in plan.md).
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  if (tags?.length) query = query.overlaps('tags', tags);
  if (scopes?.length) {
    const exactScopes: string[] = [];
    const likePatterns: string[] = [];
    for (const s of scopes) {
      if (s.endsWith('/*') || s.endsWith('::*')) {
        const base = s.toLowerCase().trim().slice(0, -1); // drop trailing '*'
        // SECURITY: `base` is interpolated into a PostgREST `.or()` filter as
        // `scope.like.<base>%`, where `,` `(` `)` are structural. A canonical
        // scope only contains [a-z0-9._:/-]; skip anything else so a crafted
        // wildcard (e.g. `a),(value.ilike.*x*::*`) cannot inject OR predicates —
        // same posture as skipping an invalid exact scope below.
        // Escape the LIKE single-char wildcard `_` so an owner prefix stays
        // owner-exact (`\` is LIKE's default escape char; `%`/`\` can't occur
        // here — the charset above excludes them).
        if (/^[a-z0-9._:/-]+$/.test(base)) likePatterns.push(base.replace(/_/g, '\\_') + '%');
      } else {
        try { exactScopes.push(validateScope(s)); } catch { /* skip invalid */ }
      }
    }
    const orParts: string[] = [];
    if (exactScopes.length) orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
    likePatterns.forEach((p) => orParts.push(`scope.like.${p}`));
    if (orParts.length) query = query.or(orParts.join(','));
  }
  // Apply cursor keyset predicate when a valid cursor is supplied.
  const decoded = cursorParam ? decodeCursor(cursorParam) : null;
  if (decoded && decoded.sort === 'updated_at') {
    query = query.or(`updated_at.lt.${decoded.ts},and(updated_at.eq.${decoded.ts},id.lt.${decoded.id})`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((row, i) => ({ ...row, rank: 1 - i * 0.05 }));
  const page = buildPage(rows, pageLimit, 'updated_at');
  span.setAttributes({ 'lorekit.result.count': page.entries.length });
  return page;
}

/** Soft-archive a memory by setting archived_at. */
export async function toolArchive(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  // Unused, and that is a decision rather than an oversight — marked the way
  // toolPurge marks its own. This tool and toolRestore address a memory by a
  // NAMED scope, so the dispatcher's early refusal is the whole key gate: a
  // scope outside the allowlist never reaches here. Unlike the reads there is
  // no result set to narrow, and unlike memory_write / memory_delete there is
  // no RPC underneath to hand the restriction to — the mutation is a direct
  // query keyed on the scope that was already checked.
  _keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
    .eq('scope', scope)
    .eq('key', key)
    .is('archived_at', null);
  if (userId) query = query.eq('user_id', userId);
  const { error, count } = await query;
  if (error) throw new Error(error.message);
  const archived = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.archived': archived });
  if (archived) {
    await recordAudit(
      db,
      { action: 'memory.archive', resourceType: 'memory', target: key, metadata: { scope, key } },
      userId,
    );
  }
  return { archived };
}

/** List archived memories for a scope. */
export async function toolListArchived(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, limit = 50 } = params;
  if (!rawScope) throw new Error('scope is required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('key,value,tags,updated_at,archived_at')
    .eq('scope', scope)
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false })
    .limit(Math.min(limit, 100));
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = data ?? [];
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}

/** Restore an archived memory by clearing archived_at. */
export async function toolRestore(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  // Named-scope mutation with no result set and no RPC underneath — the same
  // recorded decision as toolArchive above. The dispatcher's refusal is the gate.
  _keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .update({ archived_at: null }, { count: 'exact' })
    .eq('scope', scope)
    .eq('key', key)
    .not('archived_at', 'is', null);
  if (userId) query = query.eq('user_id', userId);
  const { error, count } = await query;
  if (error) throw new Error(error.message);
  const restored = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.restored': restored });
  if (restored) {
    await recordAudit(
      db,
      { action: 'memory.restore', resourceType: 'memory', target: key, metadata: { scope, key } },
      userId,
    );
  }
  return { restored };
}

/**
 * Hard-delete archived memories older than retention_days from the current user.
 * Calls the purge_archived_memories() Postgres RPC.
 */
export async function toolPurge(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
  // Refused for a scoped key at the dispatcher (ACCOUNT_WIDE_TOOLS), so the
  // restriction is never consulted here — the parameter exists only because
  // every memory tool shares one call signature.
  _keyScoping?: KeyRestriction,
) {
  const retentionDays = Math.min(Math.max(Number(params.retention_days ?? PURGE_RETENTION_DAYS_DEFAULT), 1), 365);
  if (!userId) throw new Error('memory.purge requires a user_id');

  span.setAttributes({
    'lorekit.purge.retention_days': retentionDays,
    'lorekit.scope.type': 'user',
  });

  // Use createTracedClient so the RPC call appears as a child span in traces.
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('purge_archived_memories', {
    p_user_id: userId,
    p_retention_days: retentionDays,
  });
  if (error) throw new Error(error.message);
  const purged = (data as number) ?? 0;
  span.setAttributes({ 'lorekit.result.purged': purged });
  if (purged > 0) {
    // One summary event per purge run (D6) — the RPC returns only a count,
    // not the purged rows, so a per-row audit event isn't possible.
    await recordAudit(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} archived memories`,
        metadata: { purged, retention_days: retentionDays },
      },
      userId,
    );
  }
  return { purged };
}

// ── Org management tools ────────────────────────────────────────────────────
//
// All org.* tools require a Supabase user JWT — they route through SECURITY
// DEFINER RPCs that resolve the actor from auth.uid(). api_key auth provides
// no session JWT so auth.uid() is null inside the RPCs; callers using api_key
// tokens receive a -32001 before reaching these handlers (enforced by the
// dispatcher in mcp-handler.ts).

/**
 * Resolve an org's UUID from its slug. Throws if the org does not exist or is
 * soft-deleted. Shared by toolOrgRename and toolOrgDelete — both need the id
 * to call their respective SECURITY DEFINER RPCs.
 */
async function resolveOrgId(
  tracedDb: ReturnType<typeof createTracedClient>,
  slug: string,
): Promise<string> {
  const { data: org, error } = await tracedDb
    .from('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new Error((error as { message: string }).message);
  if (!org) throw new Error(`org not found: ${slug}`);
  return (org as { id: string }).id;
}

/**
 * Create a new organization. The calling user becomes the owner.
 * Uses lorekit_org_create (00022_org_management_rpcs.sql).
 */
export async function toolOrgCreate(
  db: ReturnType<typeof createClient>,
  params: Params,
  span: Span,
) {
  const { slug, name } = params;
  if (!slug || !name) throw new Error('slug and name are required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('lorekit_org_create', { p_slug: slug, p_name: name })
    .single();

  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }

  const orgId = data as string;
  span.setAttributes({ 'lorekit.org.id': orgId });
  return { id: orgId, slug, name };
}

/**
 * List all organizations the calling user is a member of, with their role.
 * Reads from org_members (RLS-gated to the authenticated user).
 */
export async function toolOrgList(
  db: ReturnType<typeof createClient>,
  _params: Params,
  span: Span,
) {
  const tracedDb = createTracedClient(db, span);
  // Join orgs to get name + slug alongside the role. RLS on org_members
  // restricts rows to the authenticated user's own memberships; RLS on orgs
  // restricts to orgs the user belongs to (00014_orgs.sql) and excludes
  // soft-deleted orgs (00025_safe_org_deletion.sql).
  const { data, error } = await tracedDb
    .from('org_members')
    .select('role, orgs(id, slug, name, created_at)')
    .order('created_at', { referencedTable: 'orgs', ascending: false });

  if (error) throw new Error((error as { message: string }).message);

  const entries = (data ?? []).map((row) => {
    const org = row.orgs as { id: string; slug: string; name: string; created_at: string } | null;
    return {
      id: org?.id ?? null,
      slug: org?.slug ?? null,
      name: org?.name ?? null,
      role: row.role,
      created_at: org?.created_at ?? null,
    };
  });

  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}

/**
 * Rename an organization's display name. Requires admin or owner role.
 * Uses lorekit_org_rename (00022_org_management_rpcs.sql).
 */
export async function toolOrgRename(
  db: ReturnType<typeof createClient>,
  params: Params,
  span: Span,
) {
  const { slug, name } = params;
  if (!slug || !name) throw new Error('slug and name are required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const orgId = await resolveOrgId(tracedDb, slug);

  const { error } = await tracedDb
    .rpc('lorekit_org_rename', { p_org_id: orgId, p_name: name });

  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }

  return { slug, name };
}

/**
 * Delete an organization. Requires owner role. Soft-deletes the org
 * (sets deleted_at). All org lore is hidden immediately from all reads.
 * A separate purge RPC permanently cascades the delete after a retention
 * window — lorekit_org_purge (00025_safe_org_deletion.sql), SQL-only for now.
 */
export async function toolOrgDelete(
  db: ReturnType<typeof createClient>,
  params: Params,
  span: Span,
) {
  const { slug } = params;
  if (!slug) throw new Error('slug is required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const orgId = await resolveOrgId(tracedDb, slug);

  const { error } = await tracedDb
    .rpc('lorekit_org_delete', { p_org_id: orgId });

  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }

  return { deleted: true, slug };
}

/**
 * Hard-delete all active memories whose expires_at is in the past.
 * Complementary to toolPurge (which removes archived rows).
 */
export async function toolPurgeExpired(
  db: ReturnType<typeof createClient>,
  _params: Params,
  userId: string | null,
  span: Span,
  // Refused for a scoped key at the dispatcher (ACCOUNT_WIDE_TOOLS), so the
  // restriction is never consulted here — the parameter exists only because
  // every memory tool shares one call signature.
  _keyScoping?: KeyRestriction,
) {
  if (!userId) {
    throw new Error('memory.purge_expired requires a user_id');
  }

  span.setAttributes({ 'lorekit.tool.name': 'memory.purge_expired' });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('purge_expired_memories', { p_user_id: userId });

  if (error) throw new Error((error as { message: string }).message);

  const purged = (data as number) ?? 0;
  span.setAttributes({ 'lorekit.result.purged_expired': purged });

  if (purged > 0) {
    await recordAudit(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} expired memories`,
        metadata: { purged_expired: purged },
      },
      userId,
    );
  }

  return { purged };
}

/**
 * List every scope the caller can see, with its count of active (non-archived,
 * non-expired) memories and when that scope was last written to.
 *
 * THE ONE READ TOOL THAT TAKES NO SCOPE, and the reason it exists: every other
 * read tool REQUIRES one (`memory.read`/`memory.list` take a `scope`,
 * `memory.search` a `scopes` list), so without this an agent can only reach
 * lore whose scope it could already name. That made the store's contents a
 * function of what the agent happened to guess. `GET /memories/scopes` and the
 * `lorekit scopes` command have answered this since migration 00039; the MCP
 * surface was the only caller that could not ask.
 *
 * The aggregation runs in Postgres (`lorekit_memory_scopes`), NOT as a
 * `select('scope')` plus a client-side `Set`. The client-side form is silently
 * wrong past PostgREST's row cap: the response is truncated with no error, so
 * whole scopes go missing for exactly the accounts with the most lore — which
 * are the accounts that need an inventory most.
 *
 * Tenant scoping lives INSIDE the RPC (it composes `lorekit_member_org_ids`
 * exactly as the `memories` RLS read policies do), so there is deliberately no
 * `applyTenantScope` call here — there is no query to scope, and a second
 * predicate would be a place for the two to drift. This mirrors
 * `memories/handlers/scopes.ts`, which makes the same call and the same
 * argument; the two surfaces answer identically by construction.
 */
export async function toolScopes(
  db: ReturnType<typeof createClient>,
  _params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const tracedDb = createTracedClient(db, span);
  // A service-role caller has no user id; the RPC reads a null `p_user_id` on a
  // service_role connection as "no tenant filter", matching every other read.
  const { data, error } = await tracedDb.rpc('lorekit_memory_scopes', {
    p_user_id: userId ?? null,
    // Narrowed inside the RPC for the same reason the tenant filter is: there
    // is no query here to post-filter, and a second predicate out here would be
    // a place for the two to drift. Without this a key restricted to one repo
    // could still enumerate every scope name on the account — and a scope
    // string IS a repo or project name, so scoping would leak what it hides.
    p_key_scopes: keyScoping?.scopes ?? [],
    p_key_org_access: keyScoping?.orgAccess ?? 'all',
    p_key_org_ids: keyScoping?.orgIds ?? [],
  });
  if (error) throw new Error((error as { message: string }).message);

  const rows = (data ?? []) as { scope: string; count: number | string; last_activity: string | null }[];
  const scopes = rows.map((r) => ({
    scope: r.scope,
    count: Number(r.count),
    // max(created_at) over exactly the counted rows (migration 00049) — per-scope
    // freshness without listing rows to reduce them, which is the row-cap trap
    // this tool exists to avoid. Null when the scope somehow counted nothing.
    last_activity: r.last_activity ? new Date(r.last_activity).toISOString() : null,
  }));

  span.setAttributes({ 'lorekit.result_count': scopes.length });
  return { scopes };
}
