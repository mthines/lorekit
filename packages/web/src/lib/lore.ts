'use server';

/**
 * Server actions for memory (lore) management.
 * Archive, restore, purge, and paginated list — all user-scoped.
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { decodeCursor } from '@/lib/pagination/cursor';
import { clampPageSize, assemblePage, type Page } from '@/lib/pagination/keyset';
import { substringNeedle, dateRangeBounds, type DateRangeInput } from '@/lib/pagination/filters';
import { applyKeyset, runPaginatedQuery, type FilterBuilderLike } from '@/lib/pagination/apply';
import type { LessonEntry } from '@/components/lore/LessonCard';
import { scopeType } from '@/lib/scope';

// ── Edit / update ─────────────────────────────────────────────────────────────

export interface UpdateLessonInput {
  /** The fields to change. Only `value` and `tags` are user-editable in the UI. */
  value: string;
  tags: string[];
}

/**
 * Update an existing active memory's value and tags.
 *
 * Delegates to the existing `memory_write` RPC, which performs a
 * conflict-on-upsert. This preserves the `source_agent` / `trigger` /
 * `created_at` fields (they are passed through unchanged) and records a
 * `memory.update` audit event (because `xmax !== 0` on the conflict path).
 *
 * Returns `{ id }` on success, or `{ error }` on failure.
 */
export async function updateLesson(
  scope: string,
  key: string,
  input: UpdateLessonInput,
): Promise<{ id: string | null; error?: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, error: 'Not authenticated' };

  // Fetch the current row so we can forward source_agent / trigger unchanged.
  const { data: current, error: fetchError } = await supabase
    .from('memories')
    .select('source_agent, trigger')
    .eq('user_id', user.id)
    .eq('scope', scope)
    .eq('key', key)
    .is('archived_at', null)
    .single();

  if (fetchError || !current) {
    return { id: null, error: fetchError?.message ?? 'Memory not found' };
  }

  const { data, error } = await supabase
    .rpc('memory_write', {
      p_user_id: user.id,
      p_scope: scope,
      p_key: key,
      p_value: input.value,
      p_tags: input.tags,
      p_source_agent: (current as { source_agent: string | null }).source_agent ?? null,
      p_trigger: (current as { trigger: string | null }).trigger ?? null,
      p_created_at: null,
    })
    .single();

  if (error) return { id: null, error: error.message };
  revalidatePath('/lore');
  return { id: (data as { id: string }).id };
}

/** Soft-archive a memory. Returns the archived row id, or null if not found. */
export async function archiveLesson(
  scope: string,
  key: string,
): Promise<{ id: string | null; error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { id: null, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('archive_memory', {
    p_user_id: user.id,
    p_scope: scope,
    p_key: key,
  });

  if (error) return { id: null, error: error.message };
  revalidatePath('/lore');
  return { id: (data as string | null) ?? null };
}

/** Restore an archived memory back to active. */
export async function restoreLesson(
  scope: string,
  key: string,
): Promise<{ id: string | null; error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { id: null, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('restore_memory', {
    p_user_id: user.id,
    p_scope: scope,
    p_key: key,
  });

  if (error) return { id: null, error: error.message };
  revalidatePath('/lore');
  return { id: (data as string | null) ?? null };
}

/**
 * Hard-delete archived memories older than retentionDays for the current user.
 * Returns the count of permanently deleted rows.
 */
export async function purgeArchivedLessons(
  retentionDays = 30,
): Promise<{ purged: number; error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { purged: 0, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('purge_archived_memories', {
    p_user_id: user.id,
    p_retention_days: retentionDays,
  });

  if (error) return { purged: 0, error: error.message };
  revalidatePath('/lore');
  return { purged: (data as number) ?? 0 };
}

// ---------------------------------------------------------------------------
// Paginated memory listing
// ---------------------------------------------------------------------------

export interface MemoryFilters {
  /** Filter to a single scope. Omit or pass null to return all scopes. */
  scope?: string | null;
  /**
   * Case-insensitive substring match against `key` or `value`.
   * Backed by trigram GIN indexes (00013_memory_keyset_index.sql).
   */
  search?: string;
  /** Inclusive `from`/`to` interval on `created_at`. */
  range?: DateRangeInput | null;
  /** Page size, default 50, hard max 100. */
  pageSize?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /**
   * When true, returns only archived memories (archived_at IS NOT NULL).
   * When false/absent, returns only active memories (archived_at IS NULL).
   */
  showArchived?: boolean;
}

export type MemoryPage = Page<LessonEntry>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EMPTY_PAGE: MemoryPage = { rows: [], nextCursor: null, hasMore: false };

/**
 * List a keyset page of the current user's active memories, newest first,
 * with optional combinable filters (scope / search substring / date interval).
 *
 * Mirrors the `listAuditLog` pattern exactly:
 *   decode cursor → normalize filters → build query → assemble page.
 * Fails closed to an empty page on auth failure or DB error — read-only,
 * so failing closed is safe.
 */
export async function listMemories(filters: MemoryFilters = {}): Promise<MemoryPage> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return EMPTY_PAGE;

  const pageSize = clampPageSize(filters.pageSize, { def: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE });
  const cursor = decodeCursor(filters.cursor);
  const needle = substringNeedle(filters.search);
  const bounds = dateRangeBounds(filters.range);

  let base = supabase
    .from('memories')
    .select('id, scope, key, value, tags, created_at, updated_at, archived_at, source_agent, trigger')
    .eq('user_id', user.id);

  // archived_at filter: active (IS NULL) vs archived (IS NOT NULL).
  if (filters.showArchived) {
    base = base.not('archived_at', 'is', null);
  } else {
    base = base.is('archived_at', null);
  }

  // Scope filter — absent / null means "all scopes".
  if (filters.scope) {
    base = base.eq('scope', filters.scope);
  }

  // Substring search: apply ilike on key OR value. PostgREST's `.or()` takes a
  // filter string; build it only when a non-empty needle exists. The needle is
  // already escaped for LIKE metacharacters by `substringNeedle`.
  if (needle) {
    base = base.or(`key.ilike.%${needle}%,value.ilike.%${needle}%`);
  }

  // Date range bounds on created_at.
  if (bounds.gte) base = base.gte('created_at', bounds.gte);
  if (bounds.lt) base = base.lt('created_at', bounds.lt);

  const query = applyKeyset(base as unknown as FilterBuilderLike, { cursor, pageSize });

  const { data, error } = await runPaginatedQuery<Record<string, unknown>>(query);
  if (error) {
    console.error('[listMemories] DB error:', error.message);
    return EMPTY_PAGE;
  }

  const rows: (LessonEntry & { id: string })[] = (data ?? []).map((row) => ({
    id: row.id as string,
    scope: row.scope as string,
    scope_type: scopeType(row.scope as string),
    key: row.key as string,
    value: row.value as string,
    tags: (row.tags as string[]) ?? [],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    archived_at: (row.archived_at as string | null) ?? null,
    source_agent: (row.source_agent as string | null) ?? null,
    trigger: (row.trigger as string | null) ?? null,
  }));

  return assemblePage(rows, pageSize, (row) => ({ c: row.created_at, id: row.id }));
}
