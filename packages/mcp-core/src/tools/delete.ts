import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';
import { recordAudit } from '../audit.js';
import { translateOrgPermissionError } from '../org-permissions.js';

export const DeleteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  /**
   * When true, permanently hard-delete the row instead of soft-archiving it.
   * Defaults to false (soft-archive). Use with caution — hard-deleted rows
   * cannot be restored.
   */
  force: z.boolean().optional().default(false),
  // Org slug to delete under (org-owned delete). Omit for a personal memory.
  // Routed through the role-gated memory_delete RPC — never the raw
  // service-role .delete()/.update() below, which would bypass the role gate.
  org: z.string().optional(),
});

/**
 * Delete (or soft-archive) a memory.
 *
 * Default behaviour (force: false): sets archived_at on the row. The memory is
 * hidden from normal reads but can be listed via memory.list_archived and
 * restored via memory.restore. It will be permanently deleted by the purge job
 * after the configured retention window (default 30 days).
 *
 * With force: true: the row is immediately hard-deleted and cannot be recovered.
 */
export async function deleteMemory(
  db: SupabaseClient,
  raw: unknown,
  userId: string | null = null,
): Promise<{ deleted: boolean; archived: boolean }> {
  const input = DeleteInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.delete', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.delete');
    span.setAttribute('lorekit.scope', input.scope);
    span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    span.setAttribute('lorekit.key', input.key);
    span.setAttribute('lorekit.delete.force', input.force);

    try {
      if (input.org) {
        // Org-owned delete: role-gated inside the memory_delete RPC (SECURITY
        // DEFINER) — a viewer/non-member is denied via LK002, never silently
        // bypassed by a raw service-role delete/update.
        const { data, error } = await db
          .rpc('memory_delete', {
            p_user_id: userId,
            p_org_slug: input.org,
            p_scope: input.scope,
            p_key: input.key,
            p_force: input.force,
          })
          .single();

        if (error) throw translateOrgPermissionError(error);

        const row = data as { deleted: boolean; archived: boolean };
        span.setAttribute('lorekit.result.deleted', row.deleted);
        span.setAttribute('lorekit.result.archived', row.archived);
        if (row.deleted || row.archived) {
          await recordAudit(
            db,
            {
              action: row.deleted ? 'memory.delete' : 'memory.archive',
              resourceType: 'memory',
              target: input.key,
              metadata: { scope: input.scope, key: input.key, force: input.force, org: input.org },
            },
            userId,
          );
        }
        return { deleted: row.deleted, archived: row.archived };
      } else if (input.force) {
        // Hard delete — immediate, irreversible.
        // Use .match() to apply all equality filters in a single call so the
        // ownership filter (user_id) is included without extending the chain
        // depth. Without the user_id filter a service-role client would match
        // any user's row with the same (scope, key).
        const matchFilter: Record<string, string> = {
          scope: input.scope,
          key: input.key,
        };
        if (userId) matchFilter['user_id'] = userId;

        const { error, count } = await db
          .from('memories')
          .delete({ count: 'exact' })
          .match(matchFilter);

        if (error) throw error;
        const deleted = (count ?? 0) > 0;
        span.setAttribute('lorekit.result.deleted', deleted);
        span.setAttribute('lorekit.result.archived', false);
        if (deleted) {
          await recordAudit(
            db,
            {
              action: 'memory.delete',
              resourceType: 'memory',
              target: input.key,
              metadata: { scope: input.scope, key: input.key, force: true },
            },
            userId,
          );
        }
        return { deleted, archived: false };
      } else {
        // Soft-archive — set archived_at, hide from normal reads.
        // Same ownership guard as the force-delete branch above: use .match()
        // for the equality filters so user_id is always included when known,
        // then .is() for the NULL check on archived_at.
        const matchFilter: Record<string, string> = {
          scope: input.scope,
          key: input.key,
        };
        if (userId) matchFilter['user_id'] = userId;

        const { error, count } = await db
          .from('memories')
          .update({ archived_at: new Date().toISOString() }, { count: 'exact' })
          .match(matchFilter)
          .is('archived_at', null);

        if (error) throw error;
        const archived = (count ?? 0) > 0;
        span.setAttribute('lorekit.result.deleted', false);
        span.setAttribute('lorekit.result.archived', archived);
        if (archived) {
          await recordAudit(
            db,
            {
              action: 'memory.archive',
              resourceType: 'memory',
              target: input.key,
              metadata: { scope: input.scope, key: input.key, force: false },
            },
            userId,
          );
        }
        return { deleted: false, archived };
      }
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.delete',
        'lorekit.scope.type': scopeType(input.scope),
      });
    }
  });
}
