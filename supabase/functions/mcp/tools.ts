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
import { validateScope } from '../_shared/scope.ts';
import { createTracedClient, type Span } from '../_shared/otel.ts';
import { translateCapError } from './limits.ts';
import { translateOrgPermissionError } from './org-permissions.ts';
import { parseCreatedAt } from '../_shared/created-at.ts';
import { parseTtl } from './ttl.ts';
import { recordAudit } from '../_shared/audit.ts';
import { applyTenantScope } from './tenant-scope.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

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
) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger, created_at, org, ttl_days, ttl_minutes, ttl_seconds, clear_ttl = false } = params;
  if (!rawScope || !key || !value) throw new Error('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  const scope = validateScope(rawScope);
  // Optional creation-date override (migration use case). Validates + rejects
  // future dates; null when omitted so the DB applies its now() default.
  const createdAt = parseCreatedAt(created_at);
  const ttlSeconds = parseTtl({ ttl_days, ttl_minutes, ttl_seconds });

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
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb.from('memories').select('value,updated_at').eq('scope', scope).eq('key', key).is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId));
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function toolList(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, tags, limit = 50 } = params;
  if (!rawScope) throw new Error('scope is required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('key,value,tags,updated_at')
    .eq('scope', scope)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .limit(Math.min(limit, 100));
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId));
  if (tags?.length) query = query.overlaps('tags', tags);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = data ?? [];
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
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
) {
  const { q, scopes, tags, limit = 20 } = params;
  if (!q) throw new Error('q is required');

  span.setAttributes({ 'lorekit.search.query': q });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('key,value,scope,tags')
    .textSearch('fts', q, { type: 'websearch', config: 'english' })
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .limit(Math.min(limit, 100));
  // Tenant .or() and the scope-glob .or() below are applied as two separate
  // .or() calls, which PostgREST ANDs together — never merged into one
  // filter (see tenant-scope.ts and the Edge Cases note in plan.md).
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId));
  if (tags?.length) query = query.overlaps('tags', tags);
  if (scopes?.length) {
    const exactScopes: string[] = [];
    const likePatterns: string[] = [];
    for (const s of scopes) {
      if (s.endsWith('/*') || s.endsWith('::*')) {
        likePatterns.push(s.replace(/\*$/, '%'));
      } else {
        try { exactScopes.push(validateScope(s)); } catch { /* skip invalid */ }
      }
    }
    const orParts: string[] = [];
    if (exactScopes.length) orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
    likePatterns.forEach((p) => orParts.push(`scope.like.${p}`));
    if (orParts.length) query = query.or(orParts.join(','));
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = (data ?? []).map((row, i) => ({ ...row, rank: 1 - i * 0.05 }));
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}

/** Soft-archive a memory by setting archived_at. */
export async function toolArchive(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
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
  if (userId) query = applyTenantScope(query, userId, await memberOrgIds(db, userId));
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
