import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { badRequest, ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { validateScope } from '../../_shared/scope.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { ReadActivityQuerySchema } from '../../_shared/schemas/memory.ts';

/** The raw shape `lorekit_read_activity` returns (bigints arrive as strings). */
interface RawReadActivityRow {
  bucket: string;
  scope: string | null;
  count: number | string;
}

/**
 * How far back a bare call looks — the same 200-day default as
 * `GET /memories/activity`, so the two series a caller charts together cover
 * the same span without having to say so.
 */
const DEFAULT_WINDOW_DAYS = 200;
const DAY_MS = 86_400_000;

/**
 * GET /memories/read-activity — memory RECORDS read per UTC hour/day over a
 * half-open `[since, until)` window.
 *
 * The counterpart to `GET /memories/activity`: that one answers "what did I
 * write, when", this one "what did I read, when". Reads are already recorded as
 * `usage_events` rows carrying `result_count` (migration 00044), so the series
 * is a sum over the read tools — an ADDITIVE metric, which is the point: the
 * Overview's read sparkbar sums to its headline number, where a per-bucket
 * distinct count would not.
 *
 * Aggregated in Postgres (`lorekit_read_activity`, migration 00053) for the
 * `GET /memories/scopes` reason — a `select … limit N` plus a browser reduce is
 * silently truncated past PostgREST's row cap, and `usage_events` is the
 * highest-volume table in the schema.
 *
 * Visibility is self-only inside the RPC (usage is a per-user ledger, never
 * org-shared), so there is deliberately no `applyRestTenantScope` here — there
 * is no query to scope. Exactly like `handleUsage`.
 */
export async function handleReadActivity(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ReadActivityQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // The optional per-scope filter, normalised by the CANONICAL validator — the
  // same one every scope-bearing route uses, never a second grammar.
  //
  // This fails LOUD where the recording side (`safeValidateScope`, 00058) fails
  // SAFE, and the asymmetry is the point: recording a scope is a measurement
  // taken alongside an operation the caller asked for, so a bad value must not
  // break it; filtering BY a scope is the question itself, so silently dropping
  // a typo'd filter would answer a different question — "reads everywhere" —
  // under the label the caller asked for. Same call as `?correlation_id=`.
  let scopeFilter: string | null = null;
  if (params.scope !== undefined) {
    try {
      scopeFilter = validateScope(params.scope);
    } catch (e) {
      return badRequest((e as Error).message, undefined, cors);
    }
  }

  const until = params.until ?? new Date().toISOString();
  const since = params.since ?? new Date(Date.parse(until) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();

  span.setAttributes({
    'lorekit.operation': 'memories.read-activity',
    'lorekit.bucket': params.bucket,
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
  });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<RawReadActivityRow>('lorekit_read_activity', {
    p_user_id: auth.userId ?? null,
    p_bucket: params.bucket,
    p_since: since,
    p_until: until,
    p_scope: scopeFilter,
    // The calling key's scope allowlist (00067/00068), narrowed inside the RPC
    // exactly as `GET /memories/activity` and `/scopes` are: this series also
    // returns one row per scope NAME. No org parameters — `usage_events` is a
    // per-user ledger with no org axis to narrow.
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const buckets = ((data ?? []) as RawReadActivityRow[]).map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    // Nullable by contract: a read whose scope could not be resolved is
    // recorded unattributed rather than dropped, so it still counts toward the
    // account total. `?? null` normalises an absent key to the same thing.
    scope: r.scope ?? null,
    count: Number(r.count),
  }));
  span.setAttributes({ 'lorekit.result_count': buckets.length });
  return ok({ bucket: params.bucket, since, until, buckets }, cors);
}
