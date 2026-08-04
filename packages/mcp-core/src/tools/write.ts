import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope.js';
import { getTracer, getToolDurationHistogram } from '../telemetry.js';
import { translateCapError } from '../limits.js';
import { translateOrgPermissionError } from '../org-permissions.js';
import { parseCreatedAt } from '../created-at.js';
import { parseTtl } from '../ttl.js';
import { parseOrigin } from '../origin.js';
import { recordAudit } from '../audit.js';
import { MemoryKindSchema, resolveKindHost } from '@lorekit/schemas';

const MAX_VALUE_BYTES = 65_536;

export const WriteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(),
  trigger: z.string().optional(),
  // Taxonomy — the bucket KIND and owning HOST. Both optional: when omitted
  // they are derived from a `loop::<host>-lessons` tag by inferKindHost below,
  // so an older client that only sets tags still records them.
  kind: MemoryKindSchema.optional(),
  host: z.string().max(64).optional(),
  // Optional creation-date override for migrating pre-existing memories. When
  // omitted the DB applies its now() default. Validated (and future-dates
  // rejected) by parseCreatedAt below, not by zod, so the error message and the
  // clock-skew rule stay shared with the edge mirror.
  created_at: z.string().optional(),
  // Org slug to write under (org-owned write). Omit for a personal memory.
  // Ownership is authorization-derived inside memory_write — supplying an
  // org here does not by itself grant write access to it.
  org: z.string().optional(),
  // Optional TTL. Exactly one of ttl_days, ttl_minutes, or ttl_seconds may be
  // supplied. All are resolved to integer seconds by parseTtl before being
  // forwarded to the DB as p_ttl_seconds. On an UPDATE the TTL is refreshed
  // only when a ttl_* field is supplied; omitting all three leaves the existing
  // expiry unchanged. Validated by parseTtl (max 365 days per unit's ceiling).
  ttl_days: z.number().int().min(1).max(365).optional(),
  ttl_minutes: z.number().int().min(1).max(365 * 24 * 60).optional(),
  ttl_seconds: z.number().int().min(1).max(365 * 24 * 60 * 60).optional(),
  // When true, clears an existing expires_at (makes the memory permanent again).
  // Ignored when any ttl_* field is also supplied — clear takes precedence inside the RPC.
  clear_ttl: z.boolean().optional().default(false),
  // Optional provenance: WHERE this lesson was recorded from, as opposed to
  // `scope`, which says where it applies. Each field is independently optional
  // and validated (shape, charset, bounds) by parseOrigin below rather than by
  // zod, so the rules stay shared with the edge mirror. On an UPDATE the RPC
  // keeps the last KNOWN value per field — a write that omits one never erases
  // what an earlier write recorded.
  origin_repo: z.string().optional(),
  origin_branch: z.string().optional(),
  origin_commit: z.string().optional(),
  origin_pr: z.union([z.number(), z.string()]).optional(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export async function write(
  db: SupabaseClient,
  raw: unknown,
  userId: string | null = null,
): Promise<{ id: string; created_at: string; expires_at?: string | null }> {
  const input = WriteInputSchema.parse(raw);
  const createdAt = parseCreatedAt(input.created_at);
  // parseTtl validates individual bounds and mutual exclusivity. Zod has already
  // enforced the per-field ranges, but parseTtl also catches the multi-unit conflict.
  const ttlSeconds = parseTtl({
    ttl_days: input.ttl_days,
    ttl_minutes: input.ttl_minutes,
    ttl_seconds: input.ttl_seconds,
  });
  const origin = parseOrigin(input);
  // Explicit kind/host win; otherwise recover them from the loop tag (the shared
  // resolver owns the vocabulary check + host-length clamp). Null when neither is
  // available, leaving the columns NULL (a non-loop write).
  const { kind, host } = resolveKindHost({ kind: input.kind, host: input.host, tags: input.tags });
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
      if (kind) span.setAttribute('lorekit.kind', kind);
      if (host) span.setAttribute('lorekit.host', host);
      if (createdAt) span.setAttribute('lorekit.created_at', createdAt);
      // Span attribute renamed from lorekit.ttl_days to lorekit.ttl_seconds (intentional:
      // TTL is now stored and forwarded to the DB in seconds; update any dashboards or
      // alert rules that query lorekit.ttl_days).
      if (ttlSeconds !== null) span.setAttribute('lorekit.ttl_seconds', ttlSeconds);
      if (input.clear_ttl) span.setAttribute('lorekit.clear_ttl', true);
      // Origin attributes are bounded, low-cardinality-per-repo identifiers, and
      // only emitted when actually supplied.
      if (origin.repo) span.setAttribute('lorekit.origin.repo', origin.repo);
      if (origin.branch) span.setAttribute('lorekit.origin.branch', origin.branch);
      if (origin.commit) span.setAttribute('lorekit.origin.commit', origin.commit);
      if (origin.pr !== null) span.setAttribute('lorekit.origin.pr', origin.pr);

      try {
        // 00003 replaced the plain unique constraint with PARTIAL indexes
        // (WHERE archived_at IS NULL), which `.upsert(onConflict)` cannot target.
        // Writes go through the memory_write RPC (00007 → 00028) instead.
        //
        // p_user_id is the authenticated user's ID (not null for user-scoped
        // writes) so the RPC takes the user-scoped branch, enforces the
        // per-user memory cap, and records correct author attribution. Passing
        // null here would silently route every user write into the service-role /
        // CI branch of the RPC, writing user_id=null into the row and bypassing
        // the per-user cap.
        const { data, error } = await db
          .rpc('memory_write', {
            p_user_id: userId,
            p_scope: input.scope,
            p_key: input.key,
            p_value: input.value,
            p_tags: input.tags,
            p_source_agent: input.source_agent ?? null,
            p_trigger: input.trigger ?? null,
            p_created_at: createdAt,
            p_org_slug: input.org ?? null,
            p_ttl_seconds: ttlSeconds,
            p_clear_ttl: input.clear_ttl ?? false,
            p_origin_repo: origin.repo,
            p_origin_branch: origin.branch,
            p_origin_commit: origin.commit,
            p_origin_pr: origin.pr,
            p_kind: kind,
            p_host: host,
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
        if (ttlSeconds !== null || input.clear_ttl) result.expires_at = row.expires_at ?? null;
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
