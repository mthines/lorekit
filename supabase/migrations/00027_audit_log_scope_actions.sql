-- Scope-binding UI (follow-up to 00026): extend the audit_log `action` CHECK
-- with `scope.bind` and `scope.unbind` so the dashboard's scope-bindings
-- server actions can call recordAuditEvent for bind/unbind mutations.
--
-- Forward-only: drop + re-add the CHECK (a constraint can't be widened in
-- place) — the same pattern as 00023_audit_log_org_actions.sql.

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
  'scope.unbind'
));
