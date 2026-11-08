---
for: pr-reviewer
lens-version: 1
applies-to: "supabase/migrations/*.sql"
---

# Migration safety and compatibility — Review Lens

## Trigger

Any added or changed `supabase/migrations/*.sql`. The database is shared by the Edge Functions, the dashboard and the CLI, and the API-token path runs as service-role, which bypasses RLS.

## Checklist

- [ ] Every `security definer` function sets `search_path` (`set search_path = public`) and schema-qualifies anything it cannot resolve through it.
- [ ] A new function revokes execute from `public` and `anon` (and from `authenticated` when only the service role calls it); PostgreSQL grants `public` execute by default, which 00047 had to repair.
- [ ] A `security definer` RPC authorises inside its own body (actor guard, `lorekit_org_can`, a scope allowlist) and never trusts a caller-supplied `user_id` or org id.
- [ ] A new table enables row level security and defines its policies in the SAME migration; no `public` table is left open to PostgREST.
- [ ] A changed function signature is not a bare `create or replace` with different arguments (that leaves a second overload and makes the RPC call ambiguous); the old signature is dropped and its grants are re-applied.
- [ ] The migration works with the PREVIOUS commit's edge functions and dashboard, because production runs them against the new schema during rollout and after a rollback.
- [ ] The migration is idempotent where cheap (`if not exists`, `create or replace`), because the shared preview project is pushed from open PR heads and never rolled back.
- [ ] No numeric limit is hardcoded; limits come from `lorekit_default_limit` / `lorekit_get_limit`, and no project ref, secret or Vault value appears in the file.
- [ ] A new business rule, RPC or trigger has an assertion in `supabase/tests/migrations.test.sql`, and `database.types.ts` is regenerated when a table or column changes.
- [ ] The new file's number is higher than every migration on the base branch.

## Severity hints

- **Must-fix**: `security definer` without `search_path`, a missing revoke on a privileged function, a trusted caller id, a table without RLS, an ambiguous overload, a break for the previous release.
- **Should-fix**: missing test assertion, non-idempotent statements, regenerated types missing.
