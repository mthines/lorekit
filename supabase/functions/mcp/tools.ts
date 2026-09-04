/**
 * MCP tool handlers — one function per memory.* and org.* tool.
 *
 * SECURITY: When userId is provided (api_key auth), every query MUST include
 * .eq('user_id', userId). The service-role client bypasses RLS — without this
 * filter, users could access each other's memories.
 *
 * org.* tools accept BOTH auth tiers. A JWT caller resolves inside the SECURITY
 * DEFINER RPCs from auth.uid() as before; an api_key caller has no auth.uid()
 * on its service-role connection, so the resolved userId is passed explicitly
 * as `p_actor_user_id` and `lorekit_org_actor` honours it — but ONLY on a
 * verified service_role connection, so an `authenticated` caller can never
 * name someone else (00041_org_actor_override.sql).
 *
 * The SECURITY note above therefore applies to the org handlers too, and for
 * the same reason: on the api_key path RLS is bypassed, so any RAW table read
 * must carry the tenant predicate itself. Both raw reads here do —
 * `toolOrgList` on `org_members`, and `resolveOrgId` on `orgs` THROUGH the
 * caller's membership. Token permission is orthogonal to org ROLE and does not
 * replace it: `lorekit_org_can` inside the RPCs is still the only thing that
 * decides what a member may do.
 */

import { validateScope, UserInputError } from '../_shared/scope/scope.ts';
import { createTracedClient, type Span } from '../_shared/telemetry/otel.ts';
import { translateCapError } from './limits.ts';
import { translateOrgPermissionError } from './org-permissions.ts';
import { parseCreatedAt } from '../_shared/limits/created-at.ts';
import { parseTtl } from './ttl.ts';
import { parseOrigin } from '../_shared/provenance/origin.ts';
import { recordAuditDeferred } from '../_shared/audit/audit.ts';
import { applyTenantScope, type KeyRestriction } from '../_shared/auth/tenant-scope.ts';
import { decodeCursor, buildPage } from './cursor.ts';
import { pgArrayLiteral, resolveKindHost, toTagList } from '../_shared/schemas/tags.ts';
import { rankLessons, selectDiverse } from '../_shared/ranking/lesson-rank.ts';
import type { RankableLesson } from '../_shared/ranking/lesson-rank.ts';
import { outcomeFromTags } from '../_shared/ranking/outcome-signal.ts';
import type { DbClient } from '../_shared/db/db-client.ts';
import { recordMemoryReads } from '../_shared/telemetry/memory-reads.ts';
import { recordCitations } from '../_shared/telemetry/citations.ts';
import { resolveGroomConditions } from '../_shared/retention/groom.ts';
import type { RetentionPolicyRow, GroomRequestInput, GroomConditions } from '../_shared/retention/groom.ts';
import { RETENTION_POLICIES_ENABLED } from '../_shared/retention/feature-flag.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

/**
 * Characters of `value` echoed in a `view: "summary"` entry's `preview`.
 *
 * Declared locally rather than imported, following the `MAX_VALUE_BYTES` /
 * `PURGE_RETENTION_DAYS_DEFAULT` precedent directly above: this file is
 * self-contained Deno and the authoritative declaration is
 * `packages/schemas/src/domain/memory.ts` (`LIST_PREVIEW_CHARS`), kept honest by
 * `packages/mcp-core/src/ranking/list-view-parity.spec.ts`.
 */
const LIST_PREVIEW_CHARS = 200;

/**
 * Page-size ceiling for `memory.list` / `memory.list_archived`. The
 * authoritative cap is `MemoryListSchema`/`MemoryListArchivedSchema`'s
 * `limit.max()` in `packages/schemas/src/domain/memory.ts` (mirrored into the
 * `tool-catalog.ts` JSON-schema `limit` constant the two tools share) —
 * declared again here, same value, following the `LIST_PREVIEW_CHARS`
 * precedent directly above: this file is self-contained Deno and cannot
 * import across the package boundary. `memory.search` has its own, separate,
 * unchanged cap (its own inline `Math.min(limit, 100)` below).
 */
const LIST_PAGE_LIMIT_MAX = 250;

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

async function memberOrgIds(db: DbClient, userId: string): Promise<string[]> {
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
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
  // The run this write belongs to, from `X-LoreKit-Correlation-Id`. Supplied by
  // the DISPATCHER, never read from `params`: it is the same key `usage_events`
  // records for this call, which is what lets a citation (00107) join to the
  // run `/usage/runs` enumerates — and taking it from the tool args would let a
  // caller attribute its citations to somebody else's run. `memory.write` is
  // the only tool with any use for it, which is why it is a trailing optional
  // argument rather than a parameter threaded through all twelve.
  correlationId?: string | null,
) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger, created_at, org, ttl_days, ttl_minutes, ttl_seconds, clear_ttl = false, origin_repo, origin_branch, origin_commit, origin_pr, kind, host, cited } = params;
  if (!rawScope || !key || !value) throw new UserInputError('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new UserInputError(`value exceeds ${MAX_VALUE_BYTES} bytes`);
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

  await recordAuditDeferred(
    db,
    {
      action: row.inserted === false ? 'memory.update' : 'memory.create',
      resourceType: 'memory',
      resourceId: row.id,
      target: key,
      metadata: { scope, key },
    },
    userId,
    span,
  );
  // Record which lessons this write CREDITS (migration 00107). After the audit,
  // before the response is shaped, and awaited: it is one cheap RPC and every
  // failure inside it is already silent, so there is nothing here that can turn
  // a committed write into a failed call.
  await recordCitations(db, span, {
    userId,
    citingMemoryId: row.id,
    cited,
    correlationId: correlationId ?? null,
  });

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
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new UserInputError('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  // `id` is selected purely to drive the per-memory read counter below — it is
  // stripped before the tool's result is returned, so memory.read's wire
  // contract is unchanged.
  let query = tracedDb.from('memories').select('id,value,updated_at').eq('scope', scope).eq('key', key).is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  // memory.read is a TARGETED read (one exact scope+key) for the per-memory
  // counter (migration 00077) — and, since the transport IS MCP, an agent
  // deliberately opening this lesson, so it also bumps last_opened_at
  // (migration 00099).
  recordMemoryReads(db, [data.id], 'targeted', 'mcp');
  const { id: _id, ...rest } = data;
  return rest;
}

export async function toolList(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, tags: rawTags, limit = 50, cursor: cursorParam, kind, host } = params;
  // `params` is raw JSON-RPC, so `tags` can arrive as any shape — see toTagList.
  const tags = toTagList(rawTags);
  if (!rawScope) throw new UserInputError('scope is required');
  const scope = validateScope(rawScope);
  const pageLimit = Math.min(limit, LIST_PAGE_LIMIT_MAX);
  // Recorded BEFORE the clamp so a future cap decision has the caller's actual
  // ask, not just the truncated `result.count` — without this, every call
  // that wanted more than the cap is indistinguishable from one that got
  // exactly what it asked for.
  span.setAttributes({ 'lorekit.requested_limit': limit, 'lorekit.limit_capped': limit > pageLimit });

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
    if (tags.length) rankQuery = rankQuery.overlaps('tags', pgArrayLiteral(tags));
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
    // memory.list (order=rank) is a BULK read for the per-memory counter
    // (migration 00077) — one statement for the whole page.
    recordMemoryReads(db, page.map(({ entry }) => entry.id), 'bulk');
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
  if (tags.length) query = query.overlaps('tags', pgArrayLiteral(tags));
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
  // memory.list is a BULK read for the per-memory counter (migration 00077).
  // `ListRow.id` is optional only because the interface is shared with a
  // legacy shape that predates it — the query above always selects `id`, so
  // filtering `undefined` here is a type narrowing, not an expected drop.
  recordMemoryReads(db, (page.entries as ListRow[]).map((row) => row.id).filter((id): id is string => id !== undefined), 'bulk');
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
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key, force = false, org } = params;
  if (!rawScope || !key) throw new UserInputError('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({
    'lorekit.scope': scope,
    'lorekit.key': key,
    'lorekit.delete.force': force,
    ...(org ? { 'lorekit.org': org } : {}),
  });

  const tracedDb = createTracedClient(db, span);

  // Both the org and the personal branch go through the memory_delete RPC
  // (SECURITY DEFINER) — never a raw service-role .delete()/.update(), which
  // would bypass the role/ownership gate since this client bypasses RLS
  // (00046). The RPC resolves the actor, applies the key's scope allowlist and
  // org tenancy, lets a SCOPED key manage any writer's row within its scopes,
  // and returns `existed` so a 0-row removal is reported as `not_found` vs
  // `forbidden` rather than a silent false.
  const { data, error } = await tracedDb
    .rpc('memory_delete', {
      p_user_id: userId,
      p_org_slug: org ?? null,
      p_scope: scope,
      p_key: key,
      p_force: force,
      p_key_scopes: keyScoping?.scopes ?? [],
      p_key_org_access: keyScoping?.orgAccess ?? 'all',
      p_key_org_ids: keyScoping?.orgIds ?? [],
    })
    .single();
  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }
  const row = data as { deleted: boolean; archived: boolean; existed: boolean };
  span.setAttributes({
    'lorekit.result.deleted': row.deleted,
    'lorekit.result.archived': row.archived,
    'lorekit.result.existed': row.existed,
  });
  if (row.deleted || row.archived) {
    await recordAuditDeferred(
      db,
      {
        action: row.deleted ? 'memory.delete' : 'memory.archive',
        resourceType: 'memory',
        target: key,
        metadata: { scope, key, force, ...(org ? { org } : {}) },
      },
      userId,
      span,
    );
    return { deleted: row.deleted, archived: row.archived };
  }
  return {
    deleted: false,
    archived: false,
    reason: row.existed ? ('forbidden' as const) : ('not_found' as const),
  };
}

export async function toolSearch(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { q, scopes, tags: rawTags, limit = 20, cursor: cursorParam } = params;
  // `params` is raw JSON-RPC, so `tags` can arrive as any shape — see toTagList.
  const tags = toTagList(rawTags);
  if (!q) throw new UserInputError('q is required');
  const pageLimit = Math.min(limit, 100);

  // See toolList's identical comment: recorded pre-clamp so a capped call is
  // distinguishable from one that got everything it asked for.
  span.setAttributes({
    'lorekit.search.query': q,
    'lorekit.requested_limit': limit,
    'lorekit.limit_capped': limit > pageLimit,
  });

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
  if (tags.length) query = query.overlaps('tags', pgArrayLiteral(tags));
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
  // memory.search is a BULK read for the per-memory counter (migration 00077).
  recordMemoryReads(db, page.entries.map((e) => e.id), 'bulk');
  return page;
}

/** Soft-archive a memory by setting archived_at. */
export async function toolArchive(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  // Handed to the memory_delete RPC (p_force=false) so a SCOPED key can archive
  // any writer's row within the scopes it is scoped to, and so an unscoped key
  // and a non-service-role caller stay pinned to their own rows — the same
  // gate memory.delete uses. Routing through the RPC, rather than a raw
  // service-role .update(), is what keeps that authorization decision in one
  // SECURITY DEFINER place (00046).
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new UserInputError('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('memory_delete', {
      p_user_id: userId,
      p_org_slug: null,
      p_scope: scope,
      p_key: key,
      p_force: false,
      p_key_scopes: keyScoping?.scopes ?? [],
      p_key_org_access: keyScoping?.orgAccess ?? 'all',
      p_key_org_ids: keyScoping?.orgIds ?? [],
    })
    .single();
  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }
  const row = data as { deleted: boolean; archived: boolean; existed: boolean };
  span.setAttributes({ 'lorekit.result.archived': row.archived, 'lorekit.result.existed': row.existed });
  if (row.archived) {
    await recordAuditDeferred(
      db,
      { action: 'memory.archive', resourceType: 'memory', target: key, metadata: { scope, key } },
      userId,
      span,
    );
    return { archived: true };
  }
  // Nothing archived: `existed` tells the caller which no-op this was so a
  // permission/scope miss no longer masquerades as "not found".
  return { archived: false, reason: row.existed ? ('forbidden' as const) : ('not_found' as const) };
}

/** List archived memories for a scope. */
export async function toolListArchived(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, limit = 50 } = params;
  if (!rawScope) throw new UserInputError('scope is required');
  const scope = validateScope(rawScope);
  const pageLimit = Math.min(limit, LIST_PAGE_LIMIT_MAX);

  // See toolList's identical comment: recorded pre-clamp so a capped call is
  // distinguishable from one that got everything it asked for.
  span.setAttributes({
    'lorekit.scope': scope,
    'lorekit.requested_limit': limit,
    'lorekit.limit_capped': limit > pageLimit,
  });

  const tracedDb = createTracedClient(db, span);
  // `id` is selected purely to drive the per-memory read counter below — it is
  // stripped from each entry before the tool's result is returned, so
  // memory.list_archived's wire contract is unchanged.
  let query = tracedDb
    .from('memories')
    .select('id,key,value,tags,updated_at,archived_at')
    .eq('scope', scope)
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false })
    .limit(pageLimit);
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId), keyScoping);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  span.setAttributes({ 'lorekit.result.count': rows.length });
  // memory.list_archived is a BULK read for the per-memory counter
  // (migration 00077).
  recordMemoryReads(db, rows.map((r) => r.id), 'bulk');
  const entries = rows.map(({ id: _id, ...rest }) => rest);
  return { entries };
}

/** Restore an archived memory by clearing archived_at. */
export async function toolRestore(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  // Handed to the restore_memory RPC (00072) so restore is symmetric with
  // archive/delete: a scoped key restores any writer's row within its
  // allowlist, an unscoped key stays own-rows-only, and the auth decision lives
  // in one SECURITY DEFINER place rather than a raw service-role .update().
  keyScoping?: KeyRestriction,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new UserInputError('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('restore_memory', {
      p_user_id: userId,
      p_scope: scope,
      p_key: key,
      p_key_scopes: keyScoping?.scopes ?? [],
      p_key_org_access: keyScoping?.orgAccess ?? 'all',
      p_key_org_ids: keyScoping?.orgIds ?? [],
    })
    .single();
  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }
  const row = data as { restored: boolean; existed: boolean };
  span.setAttributes({ 'lorekit.result.restored': row.restored, 'lorekit.result.existed': row.existed });
  if (row.restored) {
    await recordAuditDeferred(
      db,
      { action: 'memory.restore', resourceType: 'memory', target: key, metadata: { scope, key } },
      userId,
      span,
    );
    return { restored: true };
  }
  // `existed` here means an archived row was present but this call restored
  // nothing (forbidden), vs no restorable row at all (not_found).
  return { restored: false, reason: row.existed ? ('forbidden' as const) : ('not_found' as const) };
}

/**
 * Hard-delete archived memories older than retention_days from the current user.
 * Calls the purge_archived_memories() Postgres RPC.
 */
export async function toolPurge(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
  // Refused for a scoped key at the dispatcher (ACCOUNT_WIDE_TOOLS), so the
  // restriction is never consulted here — the parameter exists only because
  // every memory tool shares one call signature.
  _keyScoping?: KeyRestriction,
) {
  const retentionDays = Math.min(Math.max(Number(params.retention_days ?? PURGE_RETENTION_DAYS_DEFAULT), 1), 365);
  if (!userId) throw new UserInputError('memory.purge requires a user_id');

  span.setAttributes({
    'lorekit.purge.retention_days': retentionDays,
    'lorekit.scope.type': 'user',
  });

  // Use createTracedClient so the RPC call appears as a child span in traces.
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<number>('purge_archived_memories', {
    p_user_id: userId,
    p_retention_days: retentionDays,
  });
  if (error) throw new Error(error.message);
  const purged = data ?? 0;
  span.setAttributes({ 'lorekit.result.purged': purged });
  if (purged > 0) {
    // One summary event per purge run (D6) — the RPC returns only a count,
    // not the purged rows, so a per-row audit event isn't possible.
    await recordAuditDeferred(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} archived memories`,
        metadata: { purged, retention_days: retentionDays },
      },
      userId,
      span,
    );
  }
  return { purged };
}

// ── Org management tools ────────────────────────────────────────────────────
//
// Both auth tiers reach these handlers. They route through SECURITY DEFINER
// RPCs, which resolve the actor one of two ways: from `auth.uid()` on a JWT
// connection, or from the explicit `p_actor_user_id` an api_key caller passes
// (honoured only on a verified service_role connection — 00041). So the
// dispatcher resolves the caller and passes `userId`: null for a JWT caller,
// where auth.uid() applies, and the token's owner for an api_key caller.
//
// A NULL actor fails closed inside the RPCs rather than defaulting to anyone.

/**
 * Resolve an org's UUID from its slug. Throws if the org does not exist, is
 * soft-deleted, or (on the api_key path) the caller is not a member.
 *
 * The membership join is NOT redundant with the role check inside the RPCs. On
 * a JWT connection RLS on `orgs` already restricts this read to the caller's
 * orgs. On an api_key connection the client is service-role, so RLS is bypassed
 * and a bare `.eq('slug', slug)` answers for EVERY org — turning this into an
 * existence oracle for any guessable slug, before any RPC gets a chance to deny
 * anything. Reading through `org_members` closes that: a non-member gets the
 * same "org not found" a non-existent slug gets, which is also the answer that
 * leaks least.
 */
async function resolveOrgId(
  tracedDb: ReturnType<typeof createTracedClient>,
  slug: string,
  userId: string | null,
): Promise<string> {
  // JWT path: unchanged, RLS-scoped.
  if (!userId) {
    const { data: org, error } = await tracedDb
      .from('orgs')
      .select('id')
      .eq('slug', slug)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error((error as { message: string }).message);
    if (!org) throw new UserInputError(`org not found: ${slug}`);
    return (org as { id: string }).id;
  }

  // api_key path: service-role, so the tenant predicate has to be explicit.
  const { data: row, error } = await tracedDb
    .from('org_members')
    .select('org_id, orgs!inner(id, slug, deleted_at)')
    .eq('user_id', userId)
    .eq('orgs.slug', slug)
    .is('orgs.deleted_at', null)
    .maybeSingle();

  if (error) throw new Error((error as { message: string }).message);
  if (!row) throw new UserInputError(`org not found: ${slug}`);
  // Routed through `unknown` rather than asserted directly, unlike the JWT
  // branch above. `maybeSingle()` returns one row at runtime but the generated
  // DB types describe it as an array, so `row as { org_id: string }` is a
  // TS2352 ("neither type sufficiently overlaps") — which is exactly the
  // `.single()`-vs-array debt the edge-typecheck baseline records. The
  // neighbouring casts are grandfathered into that ceiling; a NEW line must not
  // add to it, and the ratchet caught this one on its first run.
  return (row as unknown as { org_id: string }).org_id;
}

/**
 * Create a new organization. The calling user becomes the owner.
 * Uses lorekit_org_create (00022_org_management_rpcs.sql).
 */
export async function toolOrgCreate(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { slug, name } = params;
  if (!slug || !name) throw new UserInputError('slug and name are required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<string>('lorekit_org_create', { p_slug: slug, p_name: name, p_actor_user_id: userId })
    .single();

  if (error) {
    const translated = translateOrgPermissionError(error);
    throw translated instanceof Error ? translated : new Error((error as { message: string }).message);
  }

  const orgId = data as string;  // non-null past the error guard above
  span.setAttributes({ 'lorekit.org.id': orgId });
  return { id: orgId, slug, name };
}

/**
 * List all organizations the calling user is a member of, with their role.
 * Reads from org_members (RLS-gated to the authenticated user).
 */
export async function toolOrgList(
  db: DbClient,
  _params: Params,
  userId: string | null,
  span: Span,
) {
  const tracedDb = createTracedClient(db, span);
  // Join orgs to get name + slug alongside the role. On a JWT connection RLS on
  // org_members restricts rows to the caller's own memberships and RLS on orgs
  // to orgs they belong to (00014_orgs.sql), excluding soft-deleted ones
  // (00025_safe_org_deletion.sql).
  //
  // On the api_key path the client is SERVICE-ROLE, so neither policy applies
  // and an unfiltered read returns every membership row in the table. The
  // explicit `user_id` predicate is what stands between this tool and listing
  // other people's orgs — it is not belt-and-braces on top of RLS, it IS the
  // only tenant boundary on that path.
  // The row shape is stated explicitly because this `.select()` EMBEDS a joined
  // table, which the schema-derived row type cannot describe: `from('org_members')`
  // yields the plain `org_members` row, and that has no `orgs` property. This is
  // the case `createTracedClient.from`'s second generic exists for — see its
  // docblock. Everything else in the edge tree should take the derived row.
  type OrgMembershipRow = {
    role: string;
    orgs: { id: string; slug: string; name: string; created_at: string } | null;
  };
  let query = tracedDb
    .from<'org_members', OrgMembershipRow>('org_members')
    .select('role, orgs(id, slug, name, created_at)')
    .order('created_at', { referencedTable: 'orgs', ascending: false });
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;

  if (error) throw new Error((error as { message: string }).message);

  const entries = (data ?? []).map((row) => {
    const org = row.orgs;
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
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { slug, name } = params;
  if (!slug || !name) throw new UserInputError('slug and name are required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const orgId = await resolveOrgId(tracedDb, slug, userId);

  const { error } = await tracedDb
    .rpc('lorekit_org_rename', { p_org_id: orgId, p_name: name, p_actor_user_id: userId });

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
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { slug } = params;
  if (!slug) throw new UserInputError('slug is required');

  span.setAttributes({ 'lorekit.org.slug': slug });

  const tracedDb = createTracedClient(db, span);
  const orgId = await resolveOrgId(tracedDb, slug, userId);

  // SOFT delete (`lorekit_org_delete`, 00025) — org lore is hidden from every
  // read immediately, and a separate owner-only purge removes it for good.
  const { error } = await tracedDb
    .rpc('lorekit_org_delete', { p_org_id: orgId, p_actor_user_id: userId });

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
  db: DbClient,
  _params: Params,
  userId: string | null,
  span: Span,
  // Refused for a scoped key at the dispatcher (ACCOUNT_WIDE_TOOLS), so the
  // restriction is never consulted here — the parameter exists only because
  // every memory tool shares one call signature.
  _keyScoping?: KeyRestriction,
) {
  if (!userId) {
    throw new UserInputError('memory.purge_expired requires a user_id');
  }

  span.setAttributes({ 'lorekit.tool.name': 'memory.purge_expired' });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<number>('purge_expired_memories', { p_user_id: userId });

  if (error) throw new Error((error as { message: string }).message);

  const purged = data ?? 0;
  span.setAttributes({ 'lorekit.result.purged_expired': purged });

  if (purged > 0) {
    await recordAuditDeferred(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} expired memories`,
        metadata: { purged_expired: purged },
      },
      userId,
      span,
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
  db: DbClient,
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

// ═══════════════════════════════════════════════════════════════════════════
// Retention policies ("grooming") — policy.*, groom.*, memory.protect.
//
// v1 is personal-owned (user_id-keyed) only, so every handler below requires
// a resolved userId and every raw table read/write carries an explicit
// `user_id` predicate — the same rule every other api_key-reachable handler
// in this file follows, because that path runs on a service-role client that
// bypasses RLS. `retention_policies` itself DOES carry an owner-only RLS
// policy (00088), which is what protects the JWT/dashboard path; the
// explicit filter here is what protects the api_key path.
//
// Feature flag: when LOREKIT_RETENTION_POLICIES_ENABLED is unset or any
// value other than 'true', every handler below (and its REST twin in
// `memories/handlers/{groom,policies,protect}.ts`) rejects with
// UserInputError instead of touching the RPCs — same posture as
// GITHUB_APP_ENABLED in `mcp/webhook.ts`, kept dormant until this is rolled
// out. The nightly `pg_cron` sweep (00088) is unaffected — it only ever
// touches policies with `mode = 'auto'` AND `enabled = true`, and those can
// only be created through this same gated surface.
// ═══════════════════════════════════════════════════════════════════════════

function assertRetentionPoliciesEnabled(): void {
  if (!RETENTION_POLICIES_ENABLED) {
    throw new UserInputError('retention policies are not enabled for this instance');
  }
}

/**
 * `retention_policies` row shape, as returned by the RPCs below. Every CRUD
 * op is a SECURITY DEFINER RPC (lorekit_policy_*, 00088) rather than a raw
 * `.from('retention_policies')` call: the table is new enough that the
 * generated `database.types.ts` mirror does not know it (so a typed `.from()`
 * call cannot name it), and every other mutable resource in this schema —
 * memories, orgs, api_tokens — is already reached through a function for the
 * same api_key/service-role-bypasses-RLS reason. This is the existing
 * pattern, not a new one.
 */
interface RetentionPolicyDbRow {
  id: string;
  user_id: string;
  scope: string;
  name: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
  max_read_count: number | null;
  max_opened_count: number | null;
  tags: string[] | null;
  tags_mode: string | null;
  source_agent: string[] | null;
  source_agent_mode: string | null;
  trigger: string[] | null;
  trigger_mode: string | null;
  kind: string[] | null;
  kind_mode: string | null;
  host: string[] | null;
  host_mode: string | null;
  origin_repo: string[] | null;
  origin_repo_mode: string | null;
  origin_branch: string[] | null;
  origin_branch_mode: string | null;
  origin_pr: string[] | null;
  origin_pr_mode: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The eight dimension-filter field names a policy (or an inline groom call)
 * can carry — one list, so `toolPolicyCreate`'s RPC params, `toolPolicyUpdate`'s
 * patch whitelist, and `resolveGroomRequest`'s inline-request builder all read
 * off the SAME set rather than three hand-maintained copies that can drift.
 */
const GROOM_DIMENSION_FIELDS = [
  'tags', 'tags_mode',
  'source_agent', 'source_agent_mode',
  'trigger', 'trigger_mode',
  'kind', 'kind_mode',
  'host', 'host_mode',
  'origin_repo', 'origin_repo_mode',
  'origin_branch', 'origin_branch_mode',
  'origin_pr', 'origin_pr_mode',
] as const;

/**
 * The same 1–3650 / 0–100000 bounds `GroomConditionsSchema`
 * (`@lorekit/schemas` / `_shared/schemas/retention.ts`) enforces on the REST
 * path (`PolicyCreateBodySchema` / `PolicyUpdateBodySchema`, via
 * `validateBody`). The MCP tools take a raw `Params` object rather than a
 * validated REST body, so without this an out-of-range value here reached
 * the RPC unchecked and surfaced as a raw Postgres CHECK-constraint error
 * instead of a clean `UserInputError` — the manual-check style already used
 * by `ttl.ts`'s `parseTtlDays` et al., rather than a second zod schema.
 */
export function assertGroomConditionsInBounds(conditions: {
  min_age_days?: number | null;
  unseen_days?: number | null;
  max_seen_count?: number | null;
  max_read_count?: number | null;
  max_opened_count?: number | null;
}): void {
  const { min_age_days, unseen_days, max_seen_count, max_read_count, max_opened_count } = conditions;
  if (min_age_days != null && (min_age_days < 1 || min_age_days > 3650)) {
    throw new UserInputError('min_age_days must be between 1 and 3650');
  }
  if (unseen_days != null && (unseen_days < 1 || unseen_days > 3650)) {
    throw new UserInputError('unseen_days must be between 1 and 3650');
  }
  if (max_seen_count != null && (max_seen_count < 0 || max_seen_count > 100_000)) {
    throw new UserInputError('max_seen_count must be between 0 and 100000');
  }
  if (max_read_count != null && (max_read_count < 0 || max_read_count > 100_000)) {
    throw new UserInputError('max_read_count must be between 0 and 100000');
  }
  if (max_opened_count != null && (max_opened_count < 0 || max_opened_count > 100_000)) {
    throw new UserInputError('max_opened_count must be between 0 and 100000');
  }
}

function toPolicyRow(row: RetentionPolicyDbRow): RetentionPolicyRow {
  return {
    id: row.id,
    scope: row.scope,
    mode: row.mode,
    enabled: row.enabled,
    min_age_days: row.min_age_days,
    unseen_days: row.unseen_days,
    max_seen_count: row.max_seen_count,
    max_read_count: row.max_read_count,
    max_opened_count: row.max_opened_count,
    tags: row.tags,
    tags_mode: row.tags_mode as RetentionPolicyRow['tags_mode'],
    source_agent: row.source_agent,
    source_agent_mode: row.source_agent_mode as RetentionPolicyRow['source_agent_mode'],
    trigger: row.trigger,
    trigger_mode: row.trigger_mode as RetentionPolicyRow['trigger_mode'],
    kind: row.kind,
    kind_mode: row.kind_mode as RetentionPolicyRow['kind_mode'],
    host: row.host,
    host_mode: row.host_mode as RetentionPolicyRow['host_mode'],
    origin_repo: row.origin_repo,
    origin_repo_mode: row.origin_repo_mode as RetentionPolicyRow['origin_repo_mode'],
    origin_branch: row.origin_branch,
    origin_branch_mode: row.origin_branch_mode as RetentionPolicyRow['origin_branch_mode'],
    origin_pr: row.origin_pr,
    origin_pr_mode: row.origin_pr_mode as RetentionPolicyRow['origin_pr_mode'],
  };
}

/** List every retention policy the caller owns. */
export async function toolPolicyList(
  db: DbClient,
  _params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('policy.list requires a user_id');
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_policy_list', { p_user_id: userId });
  if (error) throw new Error((error as { message: string }).message);
  const entries = (data ?? []) as unknown as RetentionPolicyDbRow[];
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}

/** Create a retention policy. `auto` mode always starts disabled per-policy. */
export async function toolPolicyCreate(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('policy.create requires a user_id');
  const { scope: rawScope, name, mode = 'review', enabled = false, min_age_days = null, unseen_days = null, max_seen_count = null, max_read_count = null, max_opened_count = null } = params;
  if (!rawScope || !name) throw new UserInputError('scope and name are required');
  if (mode !== 'review' && mode !== 'auto') throw new UserInputError('mode must be "review" or "auto"');
  assertGroomConditionsInBounds({ min_age_days, unseen_days, max_seen_count, max_read_count, max_opened_count });
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.policy.mode': mode });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<RetentionPolicyDbRow>('lorekit_policy_create', {
      p_user_id: userId,
      p_scope: scope,
      p_name: name,
      p_mode: mode,
      p_enabled: enabled,
      p_min_age_days: min_age_days,
      p_unseen_days: unseen_days,
      p_max_seen_count: max_seen_count,
      p_max_read_count: max_read_count,
      p_max_opened_count: max_opened_count,
      // The eight dimension filters (00093) — same field names as
      // `POST /memories/list`'s body, absent means "not filtered".
      p_tags: params.tags ?? null,
      p_tags_mode: params.tags_mode ?? 'any',
      p_source_agent: params.source_agent ?? null,
      p_source_agent_mode: params.source_agent_mode ?? 'in',
      p_trigger: params.trigger ?? null,
      p_trigger_mode: params.trigger_mode ?? 'in',
      p_kind: params.kind ?? null,
      p_kind_mode: params.kind_mode ?? 'in',
      p_host: params.host ?? null,
      p_host_mode: params.host_mode ?? 'in',
      p_origin_repo: params.origin_repo ?? null,
      p_origin_repo_mode: params.origin_repo_mode ?? 'in',
      p_origin_branch: params.origin_branch ?? null,
      p_origin_branch_mode: params.origin_branch_mode ?? 'in',
      p_origin_pr: params.origin_pr ?? null,
      p_origin_pr_mode: params.origin_pr_mode ?? 'in',
    })
    .single();
  if (error) throw new Error((error as { message: string }).message);

  const row = data as RetentionPolicyDbRow;
  await recordAuditDeferred(
    db,
    { action: 'policy.create', resourceType: 'retention_policy', resourceId: row.id, target: name, metadata: { scope, mode, enabled } },
    userId,
    span,
  );
  return row;
}

/** Update a retention policy — every field but `id` is optional. */
export async function toolPolicyUpdate(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('policy.update requires a user_id');
  const { id } = params;
  if (!id) throw new UserInputError('id is required');
  if (params.mode !== undefined && params.mode !== 'review' && params.mode !== 'auto') {
    throw new UserInputError('mode must be "review" or "auto"');
  }
  assertGroomConditionsInBounds({
    min_age_days: params.min_age_days,
    unseen_days: params.unseen_days,
    max_seen_count: params.max_seen_count,
    max_read_count: params.max_read_count,
    max_opened_count: params.max_opened_count,
  });

  const patch: Record<string, unknown> = {};
  for (const field of ['name', 'mode', 'enabled', 'min_age_days', 'unseen_days', 'max_seen_count', 'max_read_count', 'max_opened_count', ...GROOM_DIMENSION_FIELDS] as const) {
    if (params[field] !== undefined) patch[field] = params[field];
  }
  if (Object.keys(patch).length === 0) throw new UserInputError('at least one field to update is required');

  span.setAttributes({ 'lorekit.policy.id': id });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('lorekit_policy_update', { p_user_id: userId, p_id: id, p_patch: patch });
  if (error) throw new Error((error as { message: string }).message);
  const row = ((data ?? []) as unknown as RetentionPolicyDbRow[])[0] ?? null;
  if (!row) throw new UserInputError(`no retention policy found for id=${id}`);

  await recordAuditDeferred(
    db,
    { action: 'policy.update', resourceType: 'retention_policy', resourceId: row.id, target: row.name, metadata: patch },
    userId,
    span,
  );
  return row;
}

/** Delete a retention policy. Deletes the RULE only — never touches memories. */
export async function toolPolicyDelete(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('policy.delete requires a user_id');
  const { id } = params;
  if (!id) throw new UserInputError('id is required');

  span.setAttributes({ 'lorekit.policy.id': id });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('lorekit_policy_delete', { p_user_id: userId, p_id: id });
  if (error) throw new Error((error as { message: string }).message);
  const row = ((data ?? []) as unknown as RetentionPolicyDbRow[])[0] ?? null;
  if (row) {
    await recordAuditDeferred(
      db,
      { action: 'policy.delete', resourceType: 'retention_policy', resourceId: row.id, target: row.name, metadata: { scope: row.scope } },
      userId,
      span,
    );
  }
  return { deleted: Boolean(row) };
}

/**
 * Resolve a groom.preview/groom.run request (a policy_id OR inline
 * conditions) into the concrete conditions struct `lorekit_groom_candidates`
 * takes — fetching the named policy (owner-scoped) when policy_id is given,
 * then delegating to the pure `resolveGroomConditions`.
 */
async function resolveGroomRequest(
  db: DbClient,
  params: Params,
  userId: string,
  span: Span,
): Promise<GroomConditions> {
  const request: GroomRequestInput = params.policy_id
    ? { policy_id: params.policy_id as string }
    : {
        scope: validateScope(params.scope),
        min_age_days: params.min_age_days,
        unseen_days: params.unseen_days,
        max_seen_count: params.max_seen_count,
        max_read_count: params.max_read_count,
        max_opened_count: params.max_opened_count,
        // The eight dimension filters — an inline groom.preview/groom.run
        // call can carry the same filters a saved policy can (00093).
        ...Object.fromEntries(
          GROOM_DIMENSION_FIELDS
            .filter((field) => params[field] !== undefined)
            .map((field) => [field, params[field]]),
        ),
      };

  let policy: RetentionPolicyRow | null = null;
  if ('policy_id' in request) {
    // No per-id fetch RPC — the owner's policy list is small (a handful of
    // saved rules), so reuse lorekit_policy_list (already owner-scoped) and
    // find the one requested rather than adding a fifth RPC for one lookup.
    const tracedDb = createTracedClient(db, span);
    const { data, error } = await tracedDb.rpc('lorekit_policy_list', { p_user_id: userId });
    if (error) throw new Error((error as { message: string }).message);
    const row = ((data ?? []) as unknown as RetentionPolicyDbRow[]).find((r) => r.id === request.policy_id) ?? null;
    if (!row) throw new UserInputError(`no retention policy found for policy_id=${request.policy_id}`);
    policy = toPolicyRow(row);
  }

  return resolveGroomConditions(request, policy);
}

/**
 * `lorekit_groom_candidates` and `lorekit_groom_run` take IDENTICAL
 * parameters — one place to build the RPC args so `toolGroomPreview` and
 * `toolGroomRun` cannot drift on which fields they send. Mirrors the REST
 * `groom.ts` handler's `groomConditionsRpcParams` (two runtimes, one shape).
 */
function groomConditionsRpcParams(userId: string, conditions: GroomConditions) {
  return {
    p_user_id: userId,
    p_scope: conditions.scope,
    p_min_age_days: conditions.min_age_days,
    p_unseen_days: conditions.unseen_days,
    p_max_seen_count: conditions.max_seen_count,
    p_max_read_count: conditions.max_read_count,
    p_max_opened_count: conditions.max_opened_count,
    p_tags: conditions.tags,
    p_tags_mode: conditions.tags_mode ?? 'any',
    p_source_agent: conditions.source_agent,
    p_source_agent_mode: conditions.source_agent_mode ?? 'in',
    p_trigger: conditions.trigger,
    p_trigger_mode: conditions.trigger_mode ?? 'in',
    p_kind: conditions.kind,
    p_kind_mode: conditions.kind_mode ?? 'in',
    p_host: conditions.host,
    p_host_mode: conditions.host_mode ?? 'in',
    p_origin_repo: conditions.origin_repo,
    p_origin_repo_mode: conditions.origin_repo_mode ?? 'in',
    p_origin_branch: conditions.origin_branch,
    p_origin_branch_mode: conditions.origin_branch_mode ?? 'in',
    p_origin_pr: conditions.origin_pr,
    p_origin_pr_mode: conditions.origin_pr_mode ?? 'in',
  };
}

/** Preview the candidates a policy or an inline condition set would archive. */
export async function toolGroomPreview(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('groom.preview requires a user_id');
  if (!params.policy_id && !params.scope) throw new UserInputError('policy_id or scope is required');

  const conditions = await resolveGroomRequest(db, params, userId, span);
  span.setAttributes({ 'lorekit.scope': conditions.scope });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_groom_candidates', groomConditionsRpcParams(userId, conditions));
  if (error) throw new Error((error as { message: string }).message);

  const rows = (data ?? []) as { id: string; scope: string; key: string }[];
  const keys = rows.map((r) => ({ scope: r.scope, key: r.key }));
  span.setAttributes({ 'lorekit.result.count': keys.length });
  return { count: keys.length, keys };
}

/**
 * Archive every candidate a policy or an inline condition set matches — the
 * SAME candidates groom.preview would have shown, resolved and archived in
 * one transaction by lorekit_groom_run. Audits one memory.archive row per
 * archived lesson (inside the RPC), never deletes.
 */
export async function toolGroomRun(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('groom.run requires a user_id');
  if (!params.policy_id && !params.scope) throw new UserInputError('policy_id or scope is required');

  const conditions = await resolveGroomRequest(db, params, userId, span);
  span.setAttributes({ 'lorekit.scope': conditions.scope });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<{ archived: number; keys: { scope: string; key: string }[] }>(
      'lorekit_groom_run',
      groomConditionsRpcParams(userId, conditions),
    )
    .single();
  if (error) throw new Error((error as { message: string }).message);

  const row = data as { archived: number; keys: { scope: string; key: string }[] };
  span.setAttributes({ 'lorekit.result.archived': row.archived });

  // App-layer audit capture (CLAUDE.md "Audit logging is captured at the app
  // layer") — one memory.archive row per archived lesson, reusing the
  // existing action rather than minting memory.groom.
  for (const k of row.keys ?? []) {
    await recordAuditDeferred(
      db,
      { action: 'memory.archive', resourceType: 'memory', target: k.key, metadata: { scope: k.scope, key: k.key, via: 'groom.run' } },
      userId,
      span,
    );
  }

  return { archived: row.archived, keys: row.keys ?? [] };
}

/** Mark or unmark a lesson as protected from every grooming candidate set. */
export async function toolProtect(
  db: DbClient,
  params: Params,
  userId: string | null,
  span: Span,
) {
  assertRetentionPoliciesEnabled();
  if (!userId) throw new UserInputError('memory.protect requires a user_id');
  const { scope: rawScope, key, protected: isProtected } = params;
  if (!rawScope || !key || typeof isProtected !== 'boolean') {
    throw new UserInputError('scope, key, and protected (boolean) are required');
  }
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key, 'lorekit.protect.value': isProtected });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<boolean>('lorekit_memory_protect', { p_user_id: userId, p_scope: scope, p_key: key, p_protected: isProtected })
    .single();
  if (error) throw new Error((error as { message: string }).message);

  const changed = Boolean(data);
  if (changed) {
    await recordAuditDeferred(
      db,
      { action: 'memory.protect', resourceType: 'memory', target: key, metadata: { scope, key, protected: isProtected } },
      userId,
      span,
    );
  }
  return { protected: isProtected };
}
