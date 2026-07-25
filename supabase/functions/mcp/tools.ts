/**
 * MCP tool handlers — one function per memory.* tool.
 *
 * SECURITY: When userId is provided (api_key auth), every query MUST include
 * .eq('user_id', userId). The service-role client bypasses RLS — without this
 * filter, users could access each other's memories.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope } from '../_shared/scope.ts';
import { createTracedClient, type Span } from '../_shared/otel.ts';
import { translateCapError } from './limits.ts';
import { parseCreatedAt } from './created-at.ts';
import { recordAudit } from './audit.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

// deno-lint-ignore no-explicit-any
export type Params = Record<string, any>;

export async function toolWrite(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger, created_at } = params;
  if (!rawScope || !key || !value) throw new Error('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  const scope = validateScope(rawScope);
  // Optional creation-date override (migration use case). Validates + rejects
  // future dates; null when omitted so the DB applies its now() default.
  const createdAt = parseCreatedAt(created_at);

  span.setAttributes({
    'lorekit.scope': scope,
    'lorekit.key': key,
    ...(source_agent ? { 'lorekit.source_agent': source_agent } : {}),
    ...(trigger ? { 'lorekit.trigger': trigger } : {}),
    ...(createdAt ? { 'lorekit.created_at': createdAt } : {}),
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
    })
    .single();
  if (error) {
    const translated = translateCapError(error);
    throw translated instanceof Error ? translated : new Error(error.message);
  }
  const row = data as { id: string; created_at: string; inserted?: boolean };
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
  return { id: row.id, created_at: row.created_at };
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
  let query = tracedDb.from('memories').select('value,updated_at').eq('scope', scope).eq('key', key).is('archived_at', null);
  if (userId) query = query.eq('user_id', userId);
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
    .order('updated_at', { ascending: false })
    .limit(Math.min(limit, 100));
  if (userId) query = query.eq('user_id', userId);
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
  const { scope: rawScope, key, force = false } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key, 'lorekit.delete.force': force });

  const tracedDb = createTracedClient(db, span);

  if (force) {
    let query = tracedDb.from('memories').delete({ count: 'exact' }).eq('scope', scope).eq('key', key);
    if (userId) query = query.eq('user_id', userId);
    const { error, count } = await query;
    if (error) throw new Error(error.message);
    const deleted = (count ?? 0) > 0;
    span.setAttributes({ 'lorekit.result.deleted': deleted, 'lorekit.result.archived': false });
    if (deleted) {
      await recordAudit(db, { action: 'memory.delete', resourceType: 'memory', target: key, metadata: { scope, key, force: true } }, userId);
    }
    return { deleted, archived: false };
  } else {
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
      await recordAudit(db, { action: 'memory.archive', resourceType: 'memory', target: key, metadata: { scope, key, force: false } }, userId);
    }
    return { deleted: false, archived };
  }
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
    .limit(Math.min(limit, 100));
  if (userId) query = query.eq('user_id', userId);
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
    await recordAudit(db, { action: 'memory.archive', resourceType: 'memory', target: key, metadata: { scope, key } }, userId);
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
  if (userId) query = query.eq('user_id', userId);
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
    await recordAudit(db, { action: 'memory.restore', resourceType: 'memory', target: key, metadata: { scope, key } }, userId);
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
      { action: 'memory.delete', resourceType: 'memory', target: `${purged} archived memories`, metadata: { purged, retention_days: retentionDays } },
      userId,
    );
  }
  return { purged };
}
