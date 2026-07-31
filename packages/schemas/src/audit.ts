import { z } from 'zod';

/**
 * The canonical `audit_log.action` vocabulary — the ONE list every surface
 * derives from.
 *
 * Why this lives in `@lorekit/schemas` and not next to a writer
 * -------------------------------------------------------------
 * The vocabulary had drifted three ways, silently:
 *
 *   - `packages/mcp-core/src/audit.ts` (and its edge mirror) declared 11
 *     actions — no `org.*`, no `member.*`, no `scope.*`.
 *   - The SQL CHECK (`00027_audit_log_scope_actions.sql`) admitted 23.
 *   - `packages/web/src/lib/audit-actions.ts` declared 24 — the 23 plus
 *     `github_app.installation_linked`.
 *
 * Nothing failed when they diverged, because `recordAudit` /
 * `recordAuditEvent` deliberately never throw: an action the CHECK rejects is
 * logged to the console and dropped. `github_app.installation_linked` was the
 * live casualty — `handleSetupReturn` audited it, the CHECK refused it, and
 * every GitHub App link silently lost its audit row.
 *
 * `@lorekit/schemas` is the right home because it is the repo's leaf package
 * (no `@lorekit/core` dependency, one-way graph) and it is already the thing
 * BOTH runtimes consume: Node imports it directly, and the Deno edge tree gets
 * a generated mirror via `scripts/sync-edge-schemas.mjs`. That makes it the
 * only place a single list can physically reach the MCP tools, the REST
 * handlers and the migration-drift guard at once.
 *
 * Who consumes this list
 * ----------------------
 *   - `packages/mcp-core/src/audit.ts`            — imports it (Node).
 *   - `supabase/functions/_shared/audit.ts`       — imports the mirror
 *     (`./schemas/audit.ts`); a bare specifier would break the edge boot, so
 *     the path must stay relative.
 *   - `supabase/migrations/*_audit_log_*.sql`     — the CHECK must list
 *     exactly these values; `audit-vocabulary.spec.ts` parses the newest such
 *     migration and asserts equality.
 *   - `packages/web/src/lib/audit-actions.ts`     — re-declares the union
 *     rather than importing (the web package deliberately has no
 *     `@lorekit/schemas` dependency: Next.js bundling +
 *     `allowImportingTsExtensions`). The same spec asserts the copy is equal,
 *     so the exemption costs nothing in safety.
 *
 * Adding an action is therefore a THREE-part change, all in one commit:
 * this list, a new `audit_log.action` CHECK migration, and the web copy.
 * `audit-vocabulary.spec.ts` fails until all three agree.
 */
export const AUDIT_ACTIONS = [
  'api_key.create',
  'api_key.revoke',
  'webhook_secret.create',
  'webhook_secret.rotate',
  'webhook_secret.deactivate',
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'limit.override',
  'org.create',
  'org.rename',
  'org.delete',
  'member.invite',
  'member.accept',
  'member.decline',
  'member.revoke',
  'member.remove',
  'member.role_change',
  'member.leave',
  'scope.bind',
  'scope.unbind',
  'github_app.installation_linked',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Zod form of the same list, for consistency with the rest of this package.
 * Derived from `AUDIT_ACTIONS` (never re-typed) so the two can never disagree.
 */
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
