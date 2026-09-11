import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { ScopeSchema, scopeType } from '../scope/scope.js';
import { pickScopeWinner, shadowedScopes } from '../scope/scope-precedence.js';
import { getTracer, getToolDurationHistogram } from '../telemetry/telemetry.js';

export const ReadInputSchema = z.object({
  /**
   * OPTIONAL. Omitting it resolves `key` across every scope the caller can see,
   * picking the winner by `scope-precedence` (project → branch → repo → global,
   * then most-recently-updated, then scope ascending) rather than failing.
   */
  scope: ScopeSchema.optional(),
  key: z.string().min(1).max(512),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
/**
 * `scope` names the scope that ANSWERED — always present, because on an
 * unscoped read the caller has no other way to tell a `global` hit from a
 * `repo::…` one. `other_scopes` appears only when the key was genuinely
 * ambiguous; an always-present empty array would be noise on every read.
 */
export type ReadResult =
  | { value: string; updated_at: string; scope: string; other_scopes?: string[] }
  | null;

/**
 * How many same-key rows an unscoped read weighs before picking. A key living
 * in more than this many distinct scopes is pathological, not a shape to design
 * for; a scoped read is unaffected, since `scope`+`key` is unique.
 */
const UNSCOPED_READ_CANDIDATE_LIMIT = 50;

export async function read(db: SupabaseClient, raw: unknown): Promise<ReadResult> {
  const input = ReadInputSchema.parse(raw);
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.memory.read', { kind: 0 }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'memory.read');
    // `lorekit.scope`/`.scope.type` are stamped from the RESOLVED scope below —
    // an unscoped read genuinely carries none up front, and a placeholder would
    // make it indistinguishable from one that named that scope.
    if (input.scope !== undefined) {
      span.setAttribute('lorekit.scope', input.scope);
      span.setAttribute('lorekit.scope.type', scopeType(input.scope));
    }
    span.setAttribute('lorekit.read.unscoped', input.scope === undefined);
    span.setAttribute('lorekit.key', input.key);

    try {
      let query = db
        .from('memories')
        .select('scope,value,updated_at')
        .eq('key', input.key)
        // Filter out archived and expired rows — both are the query layer's
        // job, not RLS's. An owner's archived rows stay visible through the
        // rls_read_archived policy (see migrations.test.sql §60c), and RLS is
        // not expiry-aware, so this tool applies both filters itself.
        .is('archived_at', null)
        .or('expires_at.is.null,expires_at.gt.now()');
      // A named scope still narrows in SQL, matching at most one row — the
      // unscoped path is the only one that fetches candidates to rank.
      if (input.scope !== undefined) query = query.eq('scope', input.scope);

      const { data, error } = await query.limit(UNSCOPED_READ_CANDIDATE_LIMIT);

      if (error) throw error;
      const rows = (data ?? []) as { scope: string; value: string; updated_at: string }[];
      const winner = pickScopeWinner(rows);
      span.setAttribute('lorekit.result.found', winner !== null);
      span.setAttribute('lorekit.read.candidates', rows.length);
      if (!winner) return null;
      span.setAttribute('lorekit.scope', winner.scope);
      span.setAttribute('lorekit.scope.type', scopeType(winner.scope));
      const others = shadowedScopes(rows, winner);
      return {
        value: winner.value,
        updated_at: winner.updated_at,
        scope: winner.scope,
        ...(others.length > 0 ? { other_scopes: others } : {}),
      };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      throw err;
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'memory.read',
        // Omitted when the caller named no scope. `lorekit.scope.type` is a
        // bounded dimension on this histogram, and there is no member of that
        // vocabulary meaning "the caller did not say" — inventing one, or
        // defaulting to `global`, would silently reattribute every unscoped
        // read's latency to a scope type it never touched.
        ...(input.scope !== undefined ? { 'lorekit.scope.type': scopeType(input.scope) } : {}),
      });
    }
  });
}
