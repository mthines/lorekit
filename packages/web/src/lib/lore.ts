'use server';

/**
 * Server actions for memory (lore) management.
 * Update, archive, restore and purge — all user-scoped MUTATIONS.
 *
 * Reads do not belong here. Next's app router runs server actions one at a
 * time per client, so a read served by one queues behind every other action in
 * flight and cannot be aborted. The paginated list used to live in this file as
 * `listMemories`; it is now a browser request (`fetchMemoryPage` in
 * `queries/lore.ts`, body built by `lib/memory-list.ts`).
 *
 * Every one of these goes through LoreKit's own REST API (the `memories` edge
 * function) rather than querying PostgREST directly. They used to do the
 * latter: a second, hand-written copy of predicates the REST handlers already
 * own — the tenant scope, the active-vs-archived partition, the expiry filter,
 * the keyset cursor, the label containment quoting. Two implementations of one
 * contract drift, and these had. The dashboard is now a client of the same
 * documented surface the CLI and every agent use.
 *
 * The mutations stay SERVER actions, reading the access token from the cookie
 * session. A mutation is a single user gesture, so the one-at-a-time queue costs
 * nothing here. The read hooks in `queries/lore.ts` use the browser session's
 * token (`session-browser.ts`), which is the same user JWT.
 */

import { revalidatePath } from 'next/cache';
import { serverAccessToken } from '@/lib/api/session-server';
import { RestApiError } from '@/lib/api/rest';
import {
  archiveMemoryRequest,
  listMemoriesRequest,
  purgeMemoriesRequest,
  restoreMemoryRequest,
  updateMemoryRequest,
} from '@/lib/api/memories';

/** Turn any thrown value into the `{ error }` string these actions return. */
function messageFor(err: unknown): string {
  if (err instanceof RestApiError) return err.message;
  return err instanceof Error ? err.message : 'Request failed';
}

// ── Edit / update ─────────────────────────────────────────────────────────────

export interface UpdateLessonInput {
  /** The fields to change. Only `value`, `tags`, and TTL are user-editable in the UI. */
  value: string;
  tags: string[];
  /** When set, refreshes the expiry to now() + ttl_days. */
  ttl_days?: number | null;
  /** When true, removes any existing expiry (makes the memory permanent). */
  clear_ttl?: boolean;
}

/**
 * Update an existing active memory's value, labels and TTL.
 *
 * Two calls, because the memory is addressed by its natural key here and
 * `PATCH /memories/:id` is addressed by row id: resolve the row, then patch it.
 * A PATCH is deliberately preferred over the `POST /memories` upsert — it
 * touches only the named columns, so `source_agent` / `trigger` / `created_at`
 * are preserved by construction instead of being read back and forwarded by
 * hand (which is what the previous direct-RPC version had to do, and what would
 * silently blank them the day someone forgot a field).
 *
 * Returns `{ id }` on success, or `{ error }` on failure.
 */
export async function updateLesson(
  scope: string,
  key: string,
  input: UpdateLessonInput,
): Promise<{ id: string | null; error?: string }> {
  const token = await serverAccessToken();
  if (!token) return { id: null, error: 'Not authenticated' };

  try {
    const found = await listMemoriesRequest(token, { scope, key, limit: 1 });
    const target = found.entries[0];
    if (!target) return { id: null, error: 'Memory not found' };

    const updated = await updateMemoryRequest(token, target.id, {
      value: input.value,
      tags: input.tags,
      ...(input.ttl_days != null ? { ttl_days: input.ttl_days } : {}),
      ...(input.clear_ttl ? { clear_ttl: true } : {}),
    });

    revalidatePath('/lore');
    return { id: updated.id };
  } catch (err) {
    return { id: null, error: messageFor(err) };
  }
}

/**
 * The result of a lifecycle mutation.
 *
 * `ok` rather than the row id these actions used to return: the REST archive is
 * a 204 and the restore a `{ restored: true }`, neither of which carries an id,
 * and no caller ever read one — the optimistic cache updates key on
 * `(scope, key)`, which is what the user acted on. Resolving an id purely to
 * satisfy the old signature would cost a round trip nobody spends.
 */
export interface LessonMutationResult {
  ok: boolean;
  error?: string;
}

/** Soft-archive a memory (never a hard delete — no `force`). */
export async function archiveLesson(scope: string, key: string): Promise<LessonMutationResult> {
  const token = await serverAccessToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    await archiveMemoryRequest(token, scope, key);
    revalidatePath('/lore');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: messageFor(err) };
  }
}

/** Restore an archived memory back to active. */
export async function restoreLesson(scope: string, key: string): Promise<LessonMutationResult> {
  const token = await serverAccessToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const { restored } = await restoreMemoryRequest(token, scope, key);
    revalidatePath('/lore');
    return { ok: restored };
  } catch (err) {
    return { ok: false, error: messageFor(err) };
  }
}

/**
 * Hard-delete archived memories older than retentionDays for the current user.
 * Returns the count of permanently deleted rows.
 */
export async function purgeArchivedLessons(
  retentionDays = 30,
): Promise<{ purged: number; error?: string }> {
  const token = await serverAccessToken();
  if (!token) return { purged: 0, error: 'Not authenticated' };

  try {
    const { purged } = await purgeMemoriesRequest(token, retentionDays);
    revalidatePath('/lore');
    return { purged };
  } catch (err) {
    return { purged: 0, error: messageFor(err) };
  }
}
