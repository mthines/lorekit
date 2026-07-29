import { SpanStatusCode } from '@opentelemetry/api';
import { type SupabaseClient } from '@supabase/supabase-js';
import { WriteInputSchema, type WriteInput, MAX_VALUE_BYTES } from '@lorekit/schemas/memory.js';
import { scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';
import { translateCapError } from '../limits.js';
import { translateOrgPermissionError } from '../org-permissions.js';
import { parseCreatedAt } from '../created-at.js';
import { parseTtlDays } from '../ttl.js';
import { recordAudit } from '../audit.js';

export { WriteInputSchema, type WriteInput };

export async function write(
  db: SupabaseClient,
  raw: unknown,
  userId: string | null = null,
): Promise<{ id: string; created_at: string; expires_at?: string | null }> {
  const input = WriteInputSchema.parse(raw);
  const createdAt = parseCreatedAt(input.created_at);
  // parseTtlDays is redundant here since zod already validates the range, but
  // calling it keeps the pure-module contract and guards against edge callers
  // that bypass the schema (the RPC validates server-side too).
  const ttlDays = parseTtlDays(input.ttl_days);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan(
    'lorekit.memory.write',
    { kind: 0 /* INTERNAL */ },
    async (span) => {
      span.setAttribute('lorekit.tool.name', 'memory.write');
      span.setAttribute('lorekit.scope', input.scope);
      span.setAttribute('lorekit.scope.type', scopeType(input.scope));
      span.setAttribute('lorekit.key', input.key);
      if (input.source_agent) span.setAttribute('lorekit.source_agent', input.source_agent);
      if (input.trigger) span.setAttribute('lorekit.trigger', input.trigger);
      if (createdAt) span.setAttribute('lorekit.created_at', createdAt);
      if (ttlDays !== null) span.setAttribute('lorekit.ttl_days', ttlDays);
      if (input.clear_ttl) span.setAttribute('lorekit.clear_ttl', true);

      try {
        // 00003 replaced the plain unique constraint with PARTIAL indexes
        // (WHERE archived_at IS NULL), which `.upsert(onConflict)` cannot target.
        // Writes go through the memory_write RPC (00007 → 00028) instead.
        const { data, error } = await db
          .rpc('memory_write', {
            p_user_id: null,
            p_scope: input.scope,
            p_key: input.key,
            p_value: input.value,
            p_tags: input.tags,
            p_source_agent: input.source_agent ?? null,
            p_trigger: input.trigger ?? null,
            p_created_at: createdAt,
            p_org_slug: input.org ?? null,
            p_ttl_days: ttlDays,
            p_clear_ttl: input.clear_ttl ?? false,
          })
          .single();

        if (error) throw translateOrgPermissionError(translateCapError(error));

        const row = data as {
          id: string;
          created_at: string;
          inserted?: boolean;
          expires_at?: string | null;
        };
        await recordAudit(
          db,
          {
            action: row.inserted === false ? 'memory.update' : 'memory.create',
            resourceType: 'memory',
            resourceId: row.id,
            target: input.key,
            metadata: { scope: input.scope, key: input.key },
          },
          userId,
        );

        span.setStatus({ code: SpanStatusCode.UNSET });
        const result: { id: string; created_at: string; expires_at?: string | null } = {
          id: row.id,
          created_at: row.created_at,
        };
        // Only include expires_at in the response when it was explicitly requested
        // (i.e. a TTL was supplied) — omitting it keeps the response stable for
        // callers that don't ask for expiry.
if (ttlDays !== null || input.clear_ttl) result.expires_at = row.expires_at ?? null;
        return result;
      } catch (err) {
        const e = err as Error;
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${e.name}: ${e.message}`,
        });
        throw err;
      } finally {
        span.end();
        hist.record((Date.now() - startTime) / 1000, {
          'lorekit.tool.name': 'memory.write',
          'lorekit.scope.type': scopeType(input.scope),
        });
      }
    },
  );
}
