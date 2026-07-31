-- REST org auditing (follow-up to 00041_org_actor_override.sql): re-state the
-- audit_log `action` CHECK so the constraint, the two TypeScript AUDIT_ACTIONS
-- copies and the dashboard's AuditAction union all enumerate the SAME list.
--
-- Forward-only: drop + re-add the CHECK (a constraint can't be widened in
-- place) — the exact pattern of 00023_audit_log_org_actions.sql and
-- 00027_audit_log_scope_actions.sql. No existing migration is edited.
--
-- WHAT ACTUALLY CHANGES
-- ---------------------
-- The 20 org/member/scope/memory/api_key/webhook/limit actions below were all
-- already admitted by 00027, INCLUDING every action the newly-audited `orgs`
-- REST handlers emit (`org.create`, `org.rename`, `org.delete`,
-- `member.invite`, `member.revoke`, `member.role_change`, `member.remove`,
-- `member.leave`). Those routes needed NO widening — the blocker was the actor
-- (00041), never the vocabulary.
--
-- This migration widens the CHECK by exactly ONE value:
-- `github_app.installation_linked`. That is a pre-existing, silent audit-loss
-- bug, not something the REST work introduces:
-- `packages/web/src/lib/github-installations.ts`'s `handleSetupReturn` has
-- audited that action since the GitHub App work landed, 00027 does not admit
-- it, Postgres rejects the INSERT, and `recordAuditEvent` is deliberately
-- non-throwing — so every GitHub App link has been losing its audit row with
-- nothing in the app layer able to observe it.
--
-- `supabase/tests/migrations.test.sql` §48 and §49 already assert this exact
-- 24-value list round-trips (and that `github_app.installation_removed` and
-- free text are still rejected), so without this migration those existing
-- assertions fail against a freshly migrated database. Widening here is also
-- what lets `packages/web/src/lib/audit-actions.ts` keep metadata for an action
-- the constraint would otherwise reject.

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
