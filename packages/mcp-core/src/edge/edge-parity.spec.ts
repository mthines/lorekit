import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the self-contained edge-function mirrors.
 *
 * Several pure modules in `packages/mcp-core/src` are duplicated verbatim into
 * the Deno edge tree (`supabase/functions/mcp/` for MCP-only logic,
 * `supabase/functions/_shared/` for logic shared by every edge function)
 * because the Deno edge function cannot cross-import the Node package
 * (Deno / Node.js MCP SDK incompatibility). Each mirror's
 * header says "keep the two in sync" and points at this package's vitest suite
 * as "the shared guard" — but nothing actually fails when the copies drift.
 *
 * These mirrors carry security-relevant logic (webhook-secret precedence,
 * created_at future-date rejection): a silent divergence between the tested
 * mcp-core copy and the deployed edge copy is exactly the bug this asserts
 * against. We compare the executable source of each pair with comments and
 * blank lines stripped, so the two are free to document themselves differently
 * (they intentionally do) but must remain behaviourally identical.
 *
 * Only import-free mirrors are covered here. `limits.ts` is also mirrored but
 * pulls in Deno-specific imports on the edge side, so a whole-file source
 * comparison does not apply; its shared pure logic is exercised by
 * `limits.spec.ts` on the mcp-core copy.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/edge
const repoRoot = path.resolve(here, '../../../..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');

// Reduce a source file to its executable lines: trim each line, drop blanks,
// and drop comment lines (line comments and every line of a block/JSDoc
// comment — see COMMENT_PREFIXES). Neither mirror uses trailing inline
// comments on code lines, so line-level stripping fully isolates the logic; if
// that ever changes, the guard tightens rather than silently passing.
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

function executableSource(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join('\n');
}

// Each entry is [mcp-core file name, edge path relative to supabase/functions].
// Some mirrors are MCP-only (`mcp/`); the `_shared/` ones are used by more than
// one edge function — trace-context.ts because every function (REST + MCP)
// parses the inbound traceparent, created-at.ts because both the MCP
// `memory.write` tool and the REST `POST /memories` handler validate the
// optional `created_at` override with it, and rest-tool-name.ts because the
// REST router derives its usage-event tool name from it.
//
// `audit.ts` is mirrored too (packages/mcp-core/src/audit/audit.ts ↔
// supabase/functions/_shared/audit/audit.ts) but is deliberately ABSENT here: like
// limits.ts, the edge copy is not import-free — it types the client as
// `ReturnType<typeof createClient>` off an `npm:` specifier where mcp-core
// types it as an imported `SupabaseClient`, so a whole-file comparison does not
// apply. The edge copy additionally carries `recordAuditDeferred`, which hands
// the insert to `EdgeRuntime.waitUntil` to keep it off the response path — a
// runtime API that exists only on the edge and so has no mcp-core counterpart
// to compare against. `buildAuditEntry` (the part that MUST stay
// byte-consistent) and `recordAudit` are covered by audit.spec.ts on the
// mcp-core copy.
const MIRRORS: ReadonlyArray<readonly [string, string]> = [
  ['../auth/auth-token.ts', 'mcp/auth-token.ts'],
  ['../limits/created-at.ts', '_shared/limits/created-at.ts'],
  ['../limits/ttl.ts', 'mcp/ttl.ts'],
  ['../limits/ttl-defaults.ts', 'mcp/ttl-defaults.ts'],
  ['../provenance/origin.ts', '_shared/provenance/origin.ts'],
  ['../webhook/webhook-secret-select.ts', 'mcp/webhook-secret-select.ts'],
  ['../auth/tenant-scope.ts', '_shared/auth/tenant-scope.ts'],
  ['../auth/org-permissions.ts', 'mcp/org-permissions.ts'],
  ['../webhook/webhook-installation.ts', 'mcp/webhook-installation.ts'],
  ['../webhook/github-app-jwt.ts', 'mcp/github-app-jwt.ts'],
  ['../telemetry/trace-context.ts', '_shared/telemetry/trace-context.ts'],
  ['../rest/rest-tool-name.ts', '_shared/rest/rest-tool-name.ts'],
  // The ranking used by GET /memories/relevant. Note this file has a SECOND,
  // cross-LANGUAGE twin that no byte comparison can cover — the CLI's
  // `lessons-pure.mjs` — guarded behaviourally by `lesson-rank-parity.spec.ts`.
  ['../ranking/lesson-rank.ts', '_shared/ranking/lesson-rank.ts'],
  // The tags/origin_pr → outcome-factor mapping the ranked reads feed the
  // scorer. Mirrored because BOTH ranked edge paths derive it —
  // memories/handlers/relevant.ts and mcp/tools.ts (order=rank) — and neither
  // can cross-import mcp-core; hoisted out of both so the two cannot drift.
  ['../ranking/outcome-signal.ts', '_shared/ranking/outcome-signal.ts'],
  // The pure half of the embedding pipeline. The impure half (`fetch`, the API
  // key) is `_shared/embedding/embedding-client.ts`, which is Deno-only and not mirrored.
  ['../provenance/embedding.ts', '_shared/embedding/embedding.ts'],
  // Two rules lifted OUT of Deno-only files so vitest can assert them:
  // rest-audit-actor.ts is `auditUserId` (was inline in _shared/api/auth.ts),
  // rest-response-outcome.ts is the status→usage_events.outcome
  // classification (was inline in _shared/api/router.ts). Both edge files now
  // import their mirror instead of holding a copy.
  ['../audit/rest-audit-actor.ts', '_shared/audit/rest-audit-actor.ts'],
  ['../rest/rest-response-outcome.ts', '_shared/rest/rest-response-outcome.ts'],
  ['../limits/dry-run.ts', '_shared/limits/dry-run.ts'],
  // Pure aggregation/window logic for GET /memories/usage — mirrored into the
  // _shared tree because the usage handler cannot cross-import mcp-core.
  ['../telemetry/usage-stats.ts', '_shared/telemetry/usage-stats.ts'],
  // The `(now, now + days]` bounds behind `GET /memories?expiring_within_days=`.
  // Mirrored for the usage-stats reason (the list handler cannot cross-import
  // mcp-core) and guarded here rather than left inline because the asymmetric
  // boundary — exclusive lower so an already-expired row is never shown,
  // inclusive upper so "within 7 days" includes day 7 — is the entire feature,
  // and a drift between the tested copy and the deployed one is silent.
  ['../limits/expiring-window.ts', '_shared/limits/expiring-window.ts'],
  // CORS origin allowlist matching (www/apex sibling expansion) — mirrored into
  // the _shared/api tree because cors.ts (Deno) cannot cross-import mcp-core.
  ['../rest/cors-origins.ts', '_shared/api/cors-origins.ts'],
  // The bounded value behind `lorekit.scope.type`. Mirrored because BOTH
  // transports resolve it before validation — mcp-handler.ts from the tool
  // arguments, api/router.ts from the query string — and neither can
  // cross-import mcp-core.
  ['../scope/scope-type-attribute.ts', '_shared/scope/scope-type-attribute.ts'],
  // Which operations sweep the whole account, and the refusal a scoped key
  // meets. Mirrored into `_shared/` rather than left in `mcp/permissions.ts`
  // because BOTH transports enforce it — the MCP dispatcher and the REST
  // `POST /memories/purge` handlers — and the REST tree cannot cross-import the
  // `mcp/` directory. A second copy is exactly how the REST half shipped
  // ungated while the docs claimed it was refused.
  ['../auth/account-wide-tools.ts', '_shared/auth/account-wide-tools.ts'],
  // The self-time / IO-wait split stamped on every root request span. Mirrored
  // because `traceRequest` (Deno) is the only caller and cannot cross-import
  // mcp-core; guarded here because the interval MERGE is the whole point — a
  // copy that drifts back to summing overlapping calls reports negative self
  // time on exactly the concurrent requests worth profiling.
  ['../telemetry/io-ledger.ts', '_shared/telemetry/io-ledger.ts'],
  // pg_stat_statements rows → OTel cumulative sums, for the `profiling`
  // function. Mirrored for the io-ledger.ts reason; guarded here because the
  // ms→s conversion and the epoch fallback for an unreset counter are both
  // silent when wrong — a drifted copy exports plausible numbers that are off
  // by 1000x or collapse into an unrateable zero-length series.
  ['../telemetry/db-query-metrics.ts', '_shared/telemetry/db-query-metrics.ts'],
  // Retention-policy candidate/precedence logic — the SQL RPC
  // (lorekit_groom_candidates) is authoritative, this is the unit-testable
  // mirror the edge groom/policy handlers use to resolve a policy_id or
  // inline request into the conditions struct the RPC takes. Mirrored because
  // the edge tree cannot cross-import mcp-core.
  ['../retention/groom.ts', '_shared/retention/groom.ts'],
];

describe('edge-function mirror parity', () => {
  it.each(MIRRORS)('%s stays behaviourally in sync with its edge mirror (%s)', (name, edgePath) => {
    const core = executableSource(path.join(here, name));
    const edge = executableSource(path.join(functionsDir, edgePath));
    // Sanity: both files exist and are non-trivial, so an empty-string match
    // can never masquerade as parity.
    expect(core.length).toBeGreaterThan(0);
    expect(edge).toBe(core);
  });
});

describe('cursor mirror parity', () => {
  // `supabase/functions/mcp/cursor.ts` is a self-contained mirror of
  // `supabase/functions/_shared/api/paginate.ts`. It cannot cross-import the
  // REST `_shared/api/` tree (edge-bare-specifier enforces self-containment).
  // This guard ensures the two stay behaviourally identical — same codec, same
  // keyset predicate, same buildPage logic — so MCP paging and REST paging
  // produce compatible cursors a caller can use interchangeably.
  it('mcp/cursor.ts stays behaviourally in sync with _shared/api/paginate.ts', () => {
    const sharedPaginate = executableSource(path.join(functionsDir, '_shared/api/paginate.ts'));
    const mcpCursor = executableSource(path.join(functionsDir, 'mcp/cursor.ts'));
    expect(sharedPaginate.length).toBeGreaterThan(0);
    expect(mcpCursor).toBe(sharedPaginate);
  });
});
