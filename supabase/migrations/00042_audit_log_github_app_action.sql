-- GitHub App installation linking: extend the audit_log `action` CHECK with
-- `github_app.installation_linked` so `handleSetupReturn`
-- (packages/web/src/lib/github-installations.ts) can record the link.
--
-- WHY: that call site has been auditing `github_app.installation_linked` since
-- the GitHub App shipped, but the CHECK — last set by
-- 00027_audit_log_scope_actions.sql over 23 actions — never admitted it. The
-- insert therefore failed the constraint on EVERY App link, and because
-- `recordAuditEvent` is deliberately non-throwing (a failed audit must never
-- break the operation it audits) the failure was swallowed and logged to the
-- server console only. The result was a silent, permanent hole in the audit
-- trail: no user ever saw an error, and no `github_app.installation_linked`
-- row was ever written. Widening the CHECK is the whole fix.
--
-- The action list below is now derived from ONE source —
-- packages/schemas/src/audit.ts's `AUDIT_ACTIONS` — and
-- packages/mcp-core/src/audit-vocabulary.spec.ts parses the newest
-- `audit_log` action-CHECK migration (this file) and fails if the two sets
-- differ. A future action must be added in both places, in one commit.
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
