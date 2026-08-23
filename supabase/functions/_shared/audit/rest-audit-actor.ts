// The REST `audit_log.user_id` actor rule.
//
// One decision — "whose id goes on the audit row for this caller?" — that used
// to live inline in `supabase/functions/_shared/api/auth.ts`, a Deno-only file
// vitest cannot import. It is a three-branch rule with a load-bearing
// interaction with an RLS policy, so it belongs where it can actually be
// asserted.
//
// THE RULE, and why each branch is what it is:
//
//   api_key  → the resolved user. That caller gets a SERVICE-ROLE client
//              (bypasses RLS), so the insert succeeds regardless; the id is
//              supplied because the human behind the token is the real actor.
//   user     → the resolved user. This is the branch that used to return
//              `null` and was wrong. A Supabase-JWT caller gets an RLS-SCOPED
//              client (ANON_KEY + `Authorization: Bearer <jwt>`), and
//              `audit_log`'s INSERT policy is
//              `rls_audit_log_insert ... with check (user_id = auth.uid())`
//              (supabase/migrations/00010_audit_log.sql). `auth.uid()` IS that
//              user's id, so passing it is precisely what satisfies the
//              policy — and passing `null` is precisely what violated it. The
//              row was then dropped, silently, because `recordAudit` never
//              throws.
//   service  → `null`. A service-role credential names no human actor. The
//              client bypasses RLS, so the row is written with a null actor
//              rather than refused, matching `audit_log.user_id`'s
//              nullability.
//
// NOTE ON MCP: `supabase/functions/mcp/auth.ts`'s `getUserId` still returns
// `null` for the JWT branch and therefore still loses those rows. REST now
// attributes JWT callers correctly and MCP does not; MCP's `getUserId` is the
// side that should converge on this rule, not the reverse.
//
// Pure and import-free so it can be mirrored verbatim into
// `supabase/functions/_shared/audit/rest-audit-actor.ts` (the edge tree cannot
// cross-import this package) and unit-tested in Node — the edge functions have
// no test harness of their own. `edge-parity.spec.ts` guards the two copies.

/**
 * The subset of the REST `AuthContext` this rule reads. Declared structurally
 * rather than imported so the module stays import-free; the real
 * `AuthContext` (`_shared/api/auth.ts`) is assignable to it.
 */
export interface RestAuthActor {
  type: 'user' | 'service' | 'api_key';
  userId?: string | undefined;
}

/**
 * The actor to stamp on an `audit_log` row for a REST caller.
 *
 * Total: an `api_key`/`user` context with no resolved `userId` (which
 * `resolveRestAuth` never produces, but the type permits) yields `null` rather
 * than `undefined`, so the column is always explicitly written.
 */
export function auditUserId(auth: RestAuthActor): string | null {
  if (auth.type === 'service') return null;
  return auth.userId ?? null;
}
