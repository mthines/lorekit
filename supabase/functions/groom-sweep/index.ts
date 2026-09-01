/**
 * LoreKit retention-policy sweep — runs the nightly auto-archive pass and
 * ships its OWN execution as OTel telemetry to Dash0.
 *
 * `lorekit_groom_sweep()` (migrations 00088/00093) has always been a raw SQL
 * function that pg_cron called DIRECTLY, entirely inside Postgres — no span,
 * no metric, nothing. That made it impossible to tell "ran and archived
 * nothing" apart from "did not run at all" or "failed silently", which is
 * exactly the gap this function closes, mirroring `profiling/index.ts`'s
 * shape for the identical underlying problem (a pg_cron job with work that
 * needs to be OBSERVABLE, not just run).
 *
 *   pg_cron (nightly, 03:17 UTC)
 *     └── lorekit_export_groom_sweep()        ← inert without vault secrets
 *           └── pg_net → POST /functions/v1/groom-sweep
 *                 └── lorekit_groom_sweep_and_record()   ← runs the sweep,
 *                       │                                   updates counters
 *                       └── buildGroomSweepMetrics()        ← pure mapper
 *                             └── POST → Dash0 /v1/metrics
 *
 * `lorekit_groom_sweep_and_record()` (migration 00095) wraps the existing,
 * already-tested `lorekit_groom_sweep()` unchanged — it runs the same sweep,
 * then records the result into a persistent counter row so this function can
 * export TRUE cumulative sums (`lorekit.groom.sweep.runs`,
 * `lorekit.groom.sweep.archived`) rather than per-run deltas.
 *
 * OPERATOR SURFACE, service-role only — same posture as profiling: this
 * reports cross-tenant sweep activity, not one caller's own data.
 *
 * Deploy with: supabase functions deploy groom-sweep --no-verify-jwt
 */

import { traceRequest, resolveEnvironmentOverride, createTracedClient } from '../_shared/telemetry/otel.ts';
import { exportMetrics } from '../_shared/telemetry/otlp-metrics.ts';
import { buildGroomSweepMetrics, type GroomSweepStatsRow } from '../_shared/telemetry/groom-sweep-metrics.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve((req: Request) =>
  traceRequest(req, 'lorekit.groom_sweep', async (span) => {
    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed', allow: 'POST' }, 405);
    }

    const resolved = await resolveRestAuth(req, span);
    // Service-role ONLY, same reasoning as profiling: a tenant `lk_*` token
    // must not be able to trigger (or even discover) the cross-tenant sweep.
    if (!resolved || resolved.auth.type !== 'service') {
      span.clientError('service_role_required');
      return json({ error: 'unauthorized' }, 401);
    }

    // Through the traced client so the sweep's own DB round-trip gets a
    // CLIENT span like any other — the sweep is now measured by the same
    // instrument it serves, not just the thing being measured.
    const { data, error } = await createTracedClient(resolved.db, span)
      .rpc<GroomSweepStatsRow[]>('lorekit_groom_sweep_and_record');

    if (error) {
      span.error(`GroomSweepFailed: ${error.message}`);
      return json({ error: 'sweep_failed', message: error.message }, 500);
    }

    const row = (data ?? [])[0];
    if (!row) {
      span.error('GroomSweepFailed: no stats row returned');
      return json({ error: 'sweep_failed', message: 'no stats row returned' }, 500);
    }

    const metrics = buildGroomSweepMetrics(row, Date.now());
    const result = await exportMetrics(metrics, {
      environmentOverride: resolveEnvironmentOverride(req),
    });

    span.setAttributes({
      'lorekit.groom_sweep.archived_this_run': row.archived_this_run,
      'lorekit.groom_sweep.policies_evaluated': row.policies_evaluated,
      'lorekit.groom_sweep.runs_total': row.runs_total,
      'lorekit.groom_sweep.archived_total': row.archived_total,
      'lorekit.groom_sweep.exported': result.exported,
    });

    const body = {
      exported: result.exported,
      archived_this_run: row.archived_this_run,
      policies_evaluated: row.policies_evaluated,
      runs_total: row.runs_total,
      archived_total: row.archived_total,
      metrics: metrics.map((m) => m.name),
      ...(result.error ? { reason: result.error } : {}),
    };

    if (result.exported) return json(body, 200);

    // Two distinct not-OK states, kept distinct on purpose — same rationale
    // as profiling: a 200 for either would let the cron report success while
    // nothing reaches Dash0, visible only as a dashboard that quietly stopped
    // updating (exactly what this function exists to prevent).
    //
    //   503 — nothing to send, or nowhere to send it (OTEL_EXPORTER_OTLP_ENDPOINT unset).
    //   502 — the export was attempted and Dash0 rejected it or was unreachable.
    const status = result.status ? 502 : 503;
    span.error(result.error ?? 'export_failed');
    return json(body, status);
  })
);
