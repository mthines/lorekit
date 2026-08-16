-- API key scoping, part 3: the audit vocabulary.
--
-- 00067 gave a key a scope allowlist and a tenancy; 00068 enforced them. Both
-- are AUTHORIZATION state, so changing them has to leave a trail — and today it
-- cannot: `audit_log_action_check` has admitted `api_key.create` and
-- `api_key.revoke` since 00010 and nothing else on that resource.
--
-- The failure mode this avoids is the one 00042 documents at length:
-- `recordAuditEvent` is deliberately non-throwing (a failed audit must never
-- break the operation it audits), so a call with an action the CHECK rejects is
-- swallowed and logged to the server console only. The result is a silent,
-- permanent hole in the trail — no error anyone sees, and no row. Widening the
-- CHECK BEFORE the call site ships is the whole fix.
--
-- One action, not two (`api_key.scope_change` rather than a set/clear pair):
-- clearing a key's scoping is the same operation with an empty argument, and
-- the metadata carries the before/after. A vocabulary that splits on the VALUE
-- of a field rather than the operation grows a term every time the field grows
-- a state.
--
-- Forward-only: drop + re-add (a CHECK cannot be widened in place) — the
-- pattern of 00023, 00027 and 00042. The list below is derived from the ONE
-- source, `packages/schemas/src/audit.ts`'s `AUDIT_ACTIONS`, and
-- `packages/mcp-core/src/audit-vocabulary.spec.ts` parses the newest
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
  'github_app.installation_linked'
));
