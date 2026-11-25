/**
 * LoreKit query profiling — ships Postgres statement-level cost to Dash0 as
 * OTel metrics.
 *
 * This is what "profiling" means for an architecture with no host to profile.
 * Dash0 collects profiles with a host-level eBPF agent; Supabase Edge Functions
 * are managed Deno isolates with no node to run one on and no userland V8
 * profiler to sample. What CAN be measured is where the time actually goes —
 * SQL — and Postgres already profiles itself. `pg_stat_statements` holds
 * server-side cost per statement SHAPE, aggregated across every caller, which
 * is the one thing the per-request CLIENT spans from `createTracedClient`
 * cannot see: they time each round-trip from the caller's side, one request at
 * a time.
 *
 * Read `lorekit_db_query_stats()` and `lorekit_db_table_stats()` (00125) → map
 * to `lorekit.db.query.*` (`_shared/telemetry/db-query-metrics.ts`) and
 * `lorekit.db.table.*` (`_shared/telemetry/db-table-metrics.ts`) → POST both in
 * one OTLP metrics request (`_shared/telemetry/otlp-metrics.ts`). Full rationale
 * in docs/otel.md → "Query-level profiling".
 *
 * OPERATOR SURFACE, service-role only. The rows are cross-tenant query shapes,
 * so no user JWT and no `lk_*` API token can reach this — the counters describe
 * the cluster, not a caller's own data.
 *
 * Normally driven every 5 minutes (00124) by the `lorekit-export-db-query-stats` pg_cron
 * job (supabase/migrations/00074_db_query_stats.sql), which is inert until an
 * operator provisions the two Vault secrets. Curl it directly with the
 * service-role key to check the pipeline by hand.
 *
 * Deploy with: supabase functions deploy profiling --no-verify-jwt
 */

import { traceRequest, resolveEnvironmentOverride, createTracedClient } from '../_shared/telemetry/otel.ts';
import { exportMetrics } from '../_shared/telemetry/otlp-metrics.ts';
import { buildDbQueryMetrics, type DbQueryStatRow } from '../_shared/telemetry/db-query-metrics.ts';
import { buildDbTableMetrics, type DbTableStatRow } from '../_shared/telemetry/db-table-metrics.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';

/**
 * How many statements to export per scrape.
 *
 * Each one is a metric SERIES per measure, so this is the cardinality dial. The
 * RPC caps it at 200 regardless of what is asked for.
 */
const DEFAULT_LIMIT = 20;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Parse `?limit=`, ignoring anything that is not a positive integer.
 *
 * A junk value falls back to the default rather than erroring: this endpoint is
 * driven by a cron job that cannot react to a 400, so a typo in a hand-run URL
 * should still produce a scrape.
 */
function parseLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

Deno.serve((req: Request) =>
  traceRequest(req, 'lorekit.profiling', async (span) => {
    span.setAttributes({ 'http.route': '/profiling' });
    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed', allow: 'POST' }, 405);
    }

    const resolved = await resolveRestAuth(req, span);
    // Service-role ONLY — not `requires: 'read'` through the router, because a
    // read-capable `lk_ro_*` token is a TENANT credential and these counters
    // are the whole cluster's. Anything that is not the service-role key is
    // refused identically, so a valid tenant token learns nothing about
    // whether this endpoint exists for it.
    if (!resolved || resolved.auth.type !== 'service') {
      span.clientError('service_role_required');
      return json({ error: 'unauthorized' }, 401);
    }

    const limit = parseLimit(new URL(req.url));
    // Through the traced client so the scrape's own DB round-trip gets a CLIENT
    // span like any other — which also feeds it to the self-time attribution,
    // so this function is measured by the same instrument it serves.
    // `rpc<T>` types the WHOLE return value, not one row (`TracedRpcQuery<T>`
    // resolves to `PostgrestResponse<T>`), so a set-returning function is
    // `DbQueryStatRow[]`. Passing the bare row type here would compile and then
    // hand `buildDbQueryMetrics` a single object where it expects an array.
    //
    // The two reads are independent, so they run concurrently. Either one
    // ERRORING fails the scrape the same way: a half export after a failed read
    // would read on a dashboard as one family of metrics quietly stopping.
    const db = createTracedClient(resolved.db, span);
    const [queries, tables] = await Promise.all([
      db.rpc<DbQueryStatRow[]>('lorekit_db_query_stats', { p_limit: limit }),
      db.rpc<DbTableStatRow[]>('lorekit_db_table_stats'),
    ]);
    const error = queries.error ?? tables.error;

    if (error) {
      span.error(`ProfilingReadFailed: ${error.message}`);
      return json({ error: 'stats_read_failed', message: error.message }, 500);
    }

    const rows = queries.data ?? [];
    const tableRows = tables.data ?? [];
    // One timestamp for the whole scrape, so both families line up.
    const now = Date.now();
    const metrics = [...buildDbQueryMetrics(rows, now), ...buildDbTableMetrics(tableRows, now)];
    const result = await exportMetrics(metrics, {
      environmentOverride: resolveEnvironmentOverride(req),
    });

    span.setAttributes({
      'lorekit.profiling.statements': rows.length,
      'lorekit.profiling.tables': tableRows.length,
      'lorekit.profiling.datapoints': result.points,
      'lorekit.profiling.exported': result.exported,
    });

    // `pg_stat_statements` absent or unreadable is NOT an error: 00074's reader
    // turns it into zero rows, and the table family still exports. It is a
    // half export by configuration, so it is said out loud — a WARN log and a
    // `warnings` entry — rather than hidden behind a bare 200.
    const warnings: string[] = [];
    if (rows.length === 0) {
      warnings.push('pg_stat_statements returned no rows: lorekit.db.query.* not exported');
      span.log('WARN', 'Profiling: pg_stat_statements returned no rows; only lorekit.db.table.* exported', {
        'lorekit.profiling.tables': tableRows.length,
      });
    }

    const body = {
      exported: result.exported,
      statements: rows.length,
      tables: tableRows.length,
      datapoints: result.points,
      metrics: metrics.map((m) => m.name),
      ...(warnings.length ? { warnings } : {}),
      ...(result.error ? { reason: result.error } : {}),
    };

    if (result.exported) return json(body, 200);

    // Two distinct not-OK states, kept distinct on purpose. A 200 for either
    // would be the exact failure this endpoint exists to prevent: a cron job
    // reporting success while nothing reaches Dash0, visible only as a
    // dashboard that quietly stopped updating.
    //
    //   503 — nothing to send, or nowhere to send it. Neither reader returned
    //         a row (pg_stat_statements absent AND no allowlisted table), or
    //         OTEL_EXPORTER_OTLP_ENDPOINT is unset.
    //         A configuration gap on THIS side.
    //   502 — the export was attempted and Dash0 rejected it or was
    //         unreachable. A problem on the far side (or a bad payload).
    //
    // `.error()` rather than `.clientError()`: nothing about this is the
    // caller's fault, so the span status genuinely is ERROR.
    const status = result.status ? 502 : 503;
    span.error(result.error ?? 'export_failed');
    return json(body, status);
  })
);
