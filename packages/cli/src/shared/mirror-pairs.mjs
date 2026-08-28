// The single-source inventory of known mcp-core ↔ edge (Deno) mirror pairs.
//
// TWO consumers read this ONE list instead of each keeping (or reconstructing)
// its own:
//   - `packages/mcp-core/src/edge/edge-parity.spec.ts` — loads it by URL (the
//     `lesson-rank-parity.spec.ts` cross-runtime pattern: this is a plain
//     `.mjs` package outside the vitest project's tsconfig) and runs its
//     byte-for-byte drift guard over every `driftChecked: true` pair.
//   - `packages/cli/src/shared/obligations-map.mjs` — generates the
//     `edge-mirror` / `edge-mirror-core` Surface-Partner Map rows from EVERY
//     pair here (`driftChecked` included), so `lorekit obligations` reports
//     the pair's ACTUAL partner.
//
// Why a flat enumerated list rather than a glob + `{name}` substitution: an
// edge mirror does not always preserve mcp-core's directory structure — e.g.
// `packages/mcp-core/src/auth/auth-token.ts` mirrors the FLAT
// `supabase/functions/mcp/auth-token.ts`, not
// `supabase/functions/mcp/auth/auth-token.ts`. A glob that assumes the same
// relative subpath on both sides reconstructs the WRONG partner path for
// every such flatten/rename and reports a real, present mirror as
// chronically unmet. Enumerating each pair's exact core/edge path from one
// inventory has no such assumption to violate.
//
// Every path is REPO-RELATIVE (not relative to this file), so both consumers
// use it directly: `edge-parity.spec.ts` joins it against the repo root,
// and `obligations-map.mjs`/`checkObligations` match it against changed-file
// path strings verbatim.
//
// `driftChecked: true`  — both files are import-free, so `edge-parity.spec.ts`
//                          also runs its whole-file byte comparison over the
//                          pair (stripped of comments/blank lines).
// `driftChecked: false` — a REAL partner for `lorekit obligations` purposes,
//                          but excluded from that byte comparison because the
//                          edge copy is not import-free (it carries Deno-only
//                          types/APIs the mcp-core copy has no counterpart
//                          for — see each entry's note below).
//
// Deliberately NOT included: `supabase/functions/mcp/cursor.ts` ↔
// `supabase/functions/_shared/api/paginate.ts` (guarded by edge-parity.spec.ts's
// separate "cursor mirror parity" block). Both sides live under
// `supabase/functions/`, so it is an edge↔edge mirror, not the mcp-core↔edge
// partnership this inventory and the `edge-mirror`/`edge-mirror-core` map
// entries model.
export const mirrorPairs = [
  { core: 'packages/mcp-core/src/auth/auth-token.ts', edge: 'supabase/functions/mcp/auth-token.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/limits/created-at.ts', edge: 'supabase/functions/_shared/limits/created-at.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/limits/ttl.ts', edge: 'supabase/functions/mcp/ttl.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/limits/ttl-defaults.ts', edge: 'supabase/functions/mcp/ttl-defaults.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/provenance/origin.ts', edge: 'supabase/functions/_shared/provenance/origin.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/webhook/webhook-secret-select.ts', edge: 'supabase/functions/mcp/webhook-secret-select.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/auth/tenant-scope.ts', edge: 'supabase/functions/_shared/auth/tenant-scope.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/auth/org-permissions.ts', edge: 'supabase/functions/mcp/org-permissions.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/webhook/webhook-installation.ts', edge: 'supabase/functions/mcp/webhook-installation.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/webhook/github-app-jwt.ts', edge: 'supabase/functions/mcp/github-app-jwt.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/telemetry/trace-context.ts', edge: 'supabase/functions/_shared/telemetry/trace-context.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/rest/rest-tool-name.ts', edge: 'supabase/functions/_shared/rest/rest-tool-name.ts', driftChecked: true },
  // The `X-LoreKit-Session-Kind` validator (migration 00082). Also has a
  // SECOND, cross-LANGUAGE twin — the CLI's `deriveSessionContext` in
  // `packages/cli/src/shared/mcp.mjs` — guarded behaviourally by
  // `packages/cli/test/session-context.test.mjs`, the same split
  // `lesson-rank.ts` uses below.
  { core: 'packages/mcp-core/src/telemetry/session-kind.ts', edge: 'supabase/functions/_shared/telemetry/session-kind.ts', driftChecked: true },
  // Has a SECOND, cross-LANGUAGE twin no byte comparison can cover — the
  // CLI's own `lessons-pure.mjs` — guarded behaviourally by
  // `lesson-rank-parity.spec.ts` instead.
  { core: 'packages/mcp-core/src/ranking/lesson-rank.ts', edge: 'supabase/functions/_shared/ranking/lesson-rank.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/ranking/outcome-signal.ts', edge: 'supabase/functions/_shared/ranking/outcome-signal.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/provenance/embedding.ts', edge: 'supabase/functions/_shared/embedding/embedding.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/audit/rest-audit-actor.ts', edge: 'supabase/functions/_shared/audit/rest-audit-actor.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/rest/rest-response-outcome.ts', edge: 'supabase/functions/_shared/rest/rest-response-outcome.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/limits/dry-run.ts', edge: 'supabase/functions/_shared/limits/dry-run.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/telemetry/usage-stats.ts', edge: 'supabase/functions/_shared/telemetry/usage-stats.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/limits/expiring-window.ts', edge: 'supabase/functions/_shared/limits/expiring-window.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/rest/cors-origins.ts', edge: 'supabase/functions/_shared/api/cors-origins.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/scope/scope-type-attribute.ts', edge: 'supabase/functions/_shared/scope/scope-type-attribute.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/auth/account-wide-tools.ts', edge: 'supabase/functions/_shared/auth/account-wide-tools.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/telemetry/io-ledger.ts', edge: 'supabase/functions/_shared/telemetry/io-ledger.ts', driftChecked: true },
  { core: 'packages/mcp-core/src/telemetry/db-query-metrics.ts', edge: 'supabase/functions/_shared/telemetry/db-query-metrics.ts', driftChecked: true },
  // Excluded from the byte-comparison drift check: the edge copy types the
  // client as `ReturnType<typeof createClient>` off an `npm:` specifier where
  // mcp-core imports a typed `SupabaseClient`, and additionally carries
  // `recordAuditDeferred` (a Deno-only `EdgeRuntime.waitUntil` API with no
  // mcp-core counterpart), so a whole-file comparison does not apply. Still a
  // real partner — this is the AC-1 example.
  { core: 'packages/mcp-core/src/audit/audit.ts', edge: 'supabase/functions/_shared/audit/audit.ts', driftChecked: false },
  // Excluded from the byte-comparison drift check for the same reason as
  // `limits.ts` generally (see edge-parity.spec.ts): the edge copy pulls in
  // Deno-specific imports, so a whole-file source comparison does not apply.
  // Its shared pure logic is exercised behaviourally by `limits.spec.ts` on
  // the mcp-core copy. Still a real partner.
  { core: 'packages/mcp-core/src/limits/limits.ts', edge: 'supabase/functions/mcp/limits.ts', driftChecked: false },
];
