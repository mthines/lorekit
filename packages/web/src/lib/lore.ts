'use server';

/**
 * Server actions for memory (lore) management.
 * Archive, restore, and purge operations — all user-scoped.
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

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
