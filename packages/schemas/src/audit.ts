import { z } from 'zod';

/**
 * The `audit_log.action` vocabulary — the SINGLE source of truth for every
 * surface that writes or renders an audit event.
 *
 * Before this module the list existed in three divergent places (the Node
 * writer `@lorekit/core`'s `audit.ts`, its self-contained Deno mirror
 * `supabase/functions/mcp/audit.ts`, and the dashboard's
 * `packages/web/src/lib/audit-actions.ts`) plus a fourth, authoritative-at-
 * runtime copy in the SQL CHECK constraint on `audit_log.action`. They drifted:
 * the writers knew 11 actions, the dashboard 24, and the CHECK 23 — and the one
 * the CHECK was missing (`github_app.installation_linked`) was being emitted by
 * `handleSetupReturn`, rejected by Postgres, and swallowed by the non-throwing
 * writer. Silent audit loss.
 *
 * This tuple is now the only hand-maintained list. `supabase/migrations/
 * 00040_audit_log_github_app_action.sql` re-states it in SQL (a CHECK cannot
 * reference TypeScript), and `packages/mcp-core/src/audit-actions-drift.spec.ts`
 * parses that migration back out and asserts the two agree as a set. Adding an
 * action is therefore exactly two edits — here, and a new forward-only
 * drop-and-re-add CHECK migration — with a test that fails if you do only one.
 *
 * Grouped by resource, and within a group in lifecycle order, so a reader can
 * see at a glance which surfaces a given resource's mutations are covered.
 */
export const AUDIT_ACTIONS = [
  // API tokens (packages/web/src/lib/tokens.ts)
  'api_key.create',
  'api_key.revoke',
  // Webhook secrets (packages/web/src/lib/webhook-secrets.ts)
  'webhook_secret.create',
  'webhook_secret.rotate',
  'webhook_secret.deactivate',
  // Memory mutations (MCP tools.ts + the memories REST handlers)
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  // Limit overrides — the one DB-trigger-sourced action (Decision D2)
  'limit.override',
  // Org lifecycle (web orgs.ts + the orgs REST handlers)
  'org.create',
  'org.rename',
  'org.delete',
  // Org membership + invites (web orgs.ts / org-invites.ts + orgs REST handlers)
  'member.invite',
  'member.accept',
  'member.decline',
  'member.revoke',
  'member.remove',
  'member.role_change',
  'member.leave',
  // Scope → org bindings (packages/web/src/lib/scope-bindings.ts)
  'scope.bind',
  'scope.unbind',
  // GitHub App installation linking (packages/web/src/lib/github-installations.ts)
  'github_app.installation_linked',
] as const;

export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/**
 * A caller's input to the audit writers (`recordAudit` / `recordRestAudit` /
 * `recordAuditEvent`). camelCase, every field but `action` optional — the
 * writers normalise absent fields to `null` when shaping the DB row.
 *
 * `.nullish()` (not `.optional()`) mirrors the pre-existing TypeScript
 * interface exactly: a caller may pass `undefined` or an explicit `null`, and
 * both mean "no value".
 */
export const AuditEntryInputSchema = z.object({
  action: AuditActionSchema,
  resourceType: z.string().nullish(),
  resourceId: z.string().nullish(),
  target: z.string().nullish(),
  metadata: z.record(z.unknown()).nullish(),
});
export type AuditEntryInput = z.infer<typeof AuditEntryInputSchema>;

/**
 * The snake_case `audit_log` row as the writers shape it — the output of
 * `buildAuditEntry`. `user_id` is deliberately absent: it is resolved by the
 * impure shell from the auth context, not by the caller, and is merged in at
 * insert time.
 */
export const AuditRowSchema = z.object({
  action: AuditActionSchema,
  resource_type: z.string().nullable(),
  resource_id: z.string().nullable(),
  target: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;
