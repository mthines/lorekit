-- Replace the dormant, unsafe org_id scaffolding on memories with a real FK
-- and a membership-verified RLS read policy.
--
-- 00001_memories.sql introduced `org_id text` plus an RLS read policy that
-- trusted a client-asserted, single-valued JWT claim
-- (`org_id = auth.jwt() ->> 'org_id'`). That is unsafe: any caller can mint
-- a JWT (or, for the api_key path, is not even gated by RLS) asserting any
-- org_id and read that org's lore. This migration:
--   1. Drops the two policies that reference the unsafe claim (00003 widened
--      them to also gate on archived_at, so both rls_read and
--      rls_read_archived must be dropped and recreated).
--   2. Converts org_id from free-text to a nullable uuid FK -> orgs(id). The
--      column has never been written by any code path (grep-verified), so
--      `org_id::uuid` casts every existing (null) value cleanly. Pre-flight
--      safety note for whoever applies this migration to a non-fresh
--      database (dev/staging/production): run
--        select count(*) from memories where org_id is not null;
--      first. A non-zero count means the cast will fail loudly (forward-only
--      migrations do not paper over that) — investigate before proceeding.
--   3. Recreates both read policies using lorekit_member_org_ids(auth.uid())
--      (00013_orgs.sql) — the single SECURITY DEFINER membership source —
--      instead of the client-asserted claim.
--
-- Writes are untouched here: memory_write (00007/00009/00011) never sets
-- org_id, so every row stays personal-only until Phase 2. The org-aware
-- unique arbiter lands in 00014.

drop policy if exists "rls_read" on memories;
drop policy if exists "rls_read_archived" on memories;

alter table memories
  alter column org_id type uuid using org_id::uuid;

alter table memories
  add constraint memories_org_id_fkey
  foreign key (org_id) references orgs(id) on delete cascade;

create policy "rls_read"
  on memories for select
  using (
    archived_at is null
    and (
      user_id = auth.uid()
      or org_id in (select lorekit_member_org_ids(auth.uid()))
    )
  );

create policy "rls_read_archived"
  on memories for select
  using (
    archived_at is not null
    and (
      user_id = auth.uid()
      or org_id in (select lorekit_member_org_ids(auth.uid()))
    )
  );
