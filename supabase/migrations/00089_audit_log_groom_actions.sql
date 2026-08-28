-- Retention policies, part 2: the audit vocabulary.
--
-- 00088 added policy.* (create/update/delete) and memory.protect as
-- security/data-affecting mutations. Every such action needs a trail, and
-- `recordAudit`/`recordAuditEvent` deliberately never throw on a rejected
-- action — a call with an action the CHECK refuses is swallowed and logged to
-- the server console only, leaving a silent, permanent hole (00070's exact
-- rationale). Widening the CHECK before the call sites ship is the whole fix.
--
-- `groom.run` reuses the EXISTING `memory.archive` action for its per-lesson
-- audit rows (see 00088's lorekit_groom_run) rather than minting a new
-- `memory.groom` — the archive path already has that action, and reusing it
-- keeps grooming's trail in the existing vocabulary instead of growing a
-- parallel one for what is, from audit_log's point of view, an archive.
--
-- Forward-only: drop + re-add (a CHECK cannot be widened in place) — the
-- 00023/00027/00042/00070 pattern. The list below is derived from the ONE
-- source, `packages/schemas/src/domain/audit.ts`'s `AUDIT_ACTIONS`, and
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
  'memory.protect'
));
