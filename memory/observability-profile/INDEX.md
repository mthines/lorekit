# Observability Profile

> Written by `measurable` `setup` mode. Committed via
> `persistent-memory` (`project-shared` tier). Re-run `/measurable setup` to update.
> Deep reference: [`docs/otel.md`](../../docs/otel.md).

Last updated: 2026-11-25

## Package Map

| Path glob | Kind | Telemetry stack | RUM/analytics stack | Defers to skill (if any) |
| --- | --- | --- | --- | --- |
| `packages/web/**` | `web` | OpenTelemetry SDK (Node, `src/instrumentation.ts`, `service.name=web`) | Dash0 SDK Web (`src/lib/dash0-rum.ts`) | `rum-tracking` (RUM event design) |
| `supabase/functions/**` | `api` | Hand-rolled OTLP exporter (`_shared/telemetry/otel.ts`, `service.name=api`, told apart by `faas.name`) | — | — |
| `packages/cli/**` | `worker` | Self-contained OTLP export (`service.name=cli`; `hook`/`mcp` untraced but metered) | — | — |
| `packages/mcp-core/**` | `shared-lib` | Pure modules mirrored into `supabase/functions/_shared/` | — | — |
| `packages/schemas/**` | `shared-lib` | — | — | — |
| `packages/feature-flags/**` | `shared-lib` | `featureFlagOtelHook` (`feature_flag.*` span attributes) | `feature_flag.<key>` on RUM signals via `packages/web` | `feature-flags` |
| `packages/smoke-tests/**`, `packages/web-e2e/**`, `packages/evals/**` | test-only | `web-e2e` ships test attempts as traces (`service.name=e2e`); otherwise none | — | — |

## Telemetry Schema

- Registry: none
- Upstream semconv dependency: —
- Weaver version: —
- CI gate: none

## Interaction Capture

- Mechanism: Dash0 SDK Web click autocapture (no custom global listener)
- Context attribute: —
- Mounted in: everywhere the RUM init runs (`src/lib/dash0-rum.ts`)
- Customer-data opt-out: —
- Test-id catalog: none

## Regression Detection Surface

- Existing dashboards: none named
- Existing check rules: Dash0 error-rate check rules — "Web — high backend error rate", "API — …" error-rate rules (see `docs/otel.md`)
- Status: covered for error rates; new signals are proposed via Dash0 chat

## Notes

- Every edge root request span carries `lorekit.io.wait_ms`, `lorekit.io.calls`, `lorekit.self_time_ms` (merged intervals, never summed).
- `deployment.environment.name` on `web` is `VERCEL_ENV` cross-checked against `NODE_ENV`; never `VERCEL_ENV` alone.
- No profiler: managed serverless only; query-level profiling via `pg_stat_statements` is the substitute.
