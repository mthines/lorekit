-- Org sharing Phase 3, migration 3 of 3: extend the audit_log `action` CHECK
-- with the 10 org-management actions so orgs.ts/org-invites.ts's
-- recordAuditEvent calls can insert them. Forward-only: drop + re-add the
-- CHECK (a constraint can't be widened in place) rather than editing the
-- shipped 00010 migration.

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
  'member.leave'
));
