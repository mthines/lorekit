-- Forward-only: drop + re-add (a CHECK cannot be widened in place) — the
-- 00023/00027/00042/00070/00089 pattern. The list below is derived from the
-- ONE source, `packages/schemas/src/domain/audit.ts`'s `AUDIT_ACTIONS`, and
-- `packages/mcp-core/src/audit/audit-vocabulary.spec.ts` parses the newest
-- action-CHECK migration (this file) and fails if the two sets differ.

alter table audit_log drop constraint audit_log_action_check;

alter table audit_log add constraint audit_log_action_check check (action in (
  'api_key.create',
  'api_key.revoke',
  'api_key.scope_change',
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
  'policy.create',
  'policy.update',
  'policy.delete',
  'memory.protect',
  'judgment_key.set',
  'judgment_key.delete'
));
