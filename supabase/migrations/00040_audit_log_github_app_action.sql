-- REST audit-log coverage, migration 1 of 1: extend the audit_log `action`
-- CHECK with `github_app.installation_linked`.
--
-- This closes a REAL, silent bug, not a speculative widening. Since the GitHub
-- App work landed, packages/web/src/lib/github-installations.ts's
-- handleSetupReturn has called recordAuditEvent with
-- 'github_app.installation_linked' — an action the 00027 CHECK does not admit.
-- Postgres rejects the INSERT, recordAuditEvent (correctly) never throws so the
-- primary operation succeeds, and the audit event is dropped with nothing but a
-- console.error to show for it. Every App installation linked to a LoreKit
-- account since then is missing from the audit trail.
--
-- After this migration the CHECK list is exactly AUDIT_ACTIONS in
-- packages/schemas/src/audit.ts — now the single source of truth for the
-- vocabulary. packages/mcp-core/src/audit-actions-drift.spec.ts parses the
-- latest audit_log CHECK out of this directory and asserts the two agree, so a
-- future action added to one and not the other fails CI.
--
-- Forward-only: drop + re-add the CHECK (a constraint can't be widened in
-- place) — the same pattern as 00023_audit_log_org_actions.sql and
-- 00027_audit_log_scope_actions.sql.

alter table audit_log drop constraint audit_log_action_check;

alter table audit_log add constraint audit_log_action_check check (action in (
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
  'github_app.installation_linked'
));
