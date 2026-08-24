-- Database-level regression tests for the SQL migrations.
--
-- These assert the business rules that live ONLY in Postgres — triggers, RPCs,
-- RLS policies, and constraints — which the app-layer unit tests can merely
-- *assume*. The mocked handler specs and the pure limits.ts/created-at.ts unit
-- tests encode the contract the DB is expected to honour; this file proves the
-- DB actually honours it, so a silent SQL regression (a trigger that stops
-- firing, an upsert that moves created_at, a unique index that lets duplicates
-- through) fails CI instead of reaching staging.
--
-- Run directly on Postgres against a booted local stack — NOT through
-- PostgREST/the edge function — so the tests exercise the raw SQL and sidestep
-- the older local PostgREST's upsert-arbiter limitation noted in CLAUDE.md.
--
-- Vehicle: plain psql + plpgsql ASSERT. The whole run is one transaction that
-- ROLLBACKs at the end, so it leaves no residue and is safely re-runnable.
-- `\set ON_ERROR_STOP on` turns any failed ASSERT (or unexpected error) into a
-- non-zero psql exit — which is exactly what the CI step checks.

\set ON_ERROR_STOP on

begin;

-- ── Seed: isolated test users in auth.users ─────────────────────────────────
-- Fixed UUIDs so the assertions can reference them. Only `id` needs to exist to
-- satisfy the memories.user_id FK; the other columns are filled for realism.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'lk-mig-a@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'lk-mig-b@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c3', 'authenticated', 'authenticated', 'lk-mig-c@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d4', 'authenticated', 'authenticated', 'lk-mig-d@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000e5', 'authenticated', 'authenticated', 'lk-mig-e@test.local', now(), now());

-- ── 1. RLS isolates one user's memories from another's (00001 + 00003) ──────
-- Proves RLS is actually enabled and the select policy scopes reads to
-- auth.uid(). Written as the migration owner (superuser bypasses RLS), read as
-- the `authenticated` role with a forged JWT claim so the policy engages.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'rls-a', 'value a'),
  ('00000000-0000-0000-0000-0000000000b2', 'global', 'rls-b', 'value b');

do $$
declare
  v_own  int;
  v_other int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select count(*) into v_own   from memories where key in ('rls-a', 'rls-b');
  select count(*) into v_other from memories where key = 'rls-b';

  reset role;

  assert v_own = 1,
    format('RLS: user A should see exactly its own row of the two seeded, saw %s', v_own);
  assert v_other = 0, 'RLS: user A must not see user B''s row';
end;
$$;

-- ── 2. Memory-cap trigger rejects the over-limit insert (00004) ─────────────
-- The authoritative guardrail. Give user C a tiny override so we assert the
-- boundary without inserting 1000 rows, then confirm the trigger raises the
-- custom SQLSTATE LK001 that the app layer translates into a LimitError.
insert into user_limits (user_id, max_memories)
values ('00000000-0000-0000-0000-0000000000c3', 2);

do $$
declare v_blocked boolean := false;
begin
  insert into memories (user_id, scope, key, value) values ('00000000-0000-0000-0000-0000000000c3', 'global', 'cap-1', 'v');
  insert into memories (user_id, scope, key, value) values ('00000000-0000-0000-0000-0000000000c3', 'global', 'cap-2', 'v');
  begin
    insert into memories (user_id, scope, key, value) values ('00000000-0000-0000-0000-0000000000c3', 'global', 'cap-3', 'v');
  exception when sqlstate 'LK001' then
    v_blocked := true;
  end;
  assert v_blocked,
    'memory cap: the 3rd insert at limit=2 must raise SQLSTATE LK001';
end;
$$;

-- Service-role writes (user_id IS NULL) are exempt from the cap — three inserts
-- past any per-user limit must all succeed.
do $$
begin
  insert into memories (user_id, scope, key, value) values (null, 'global', 'cap-svc-1', 'v');
  insert into memories (user_id, scope, key, value) values (null, 'global', 'cap-svc-2', 'v');
  insert into memories (user_id, scope, key, value) values (null, 'global', 'cap-svc-3', 'v');
  -- Reaching here without an exception is the assertion.
end;
$$;

-- ── 3. Rate-limit RPC counts within the window and blocks over it (00004) ───
insert into user_limits (user_id, requests_per_minute)
values ('00000000-0000-0000-0000-0000000000d4', 2);

do $$
declare r1 record; r2 record; r3 record;
begin
  select * into r1 from lorekit_check_rate_limit('00000000-0000-0000-0000-0000000000d4', 60);
  select * into r2 from lorekit_check_rate_limit('00000000-0000-0000-0000-0000000000d4', 60);
  select * into r3 from lorekit_check_rate_limit('00000000-0000-0000-0000-0000000000d4', 60);

  assert r1.allowed and r1.current_count = 1,
    format('rate limit: call 1 should be allowed at count 1 (got allowed=%s count=%s)', r1.allowed, r1.current_count);
  assert r2.allowed and r2.current_count = 2,
    format('rate limit: call 2 should be allowed at count 2 (got allowed=%s count=%s)', r2.allowed, r2.current_count);
  assert (not r3.allowed) and r3.current_count = 3 and r3.limit_value = 2,
    format('rate limit: call 3 must be blocked (allowed=%s count=%s limit=%s)', r3.allowed, r3.current_count, r3.limit_value);
  assert r3.retry_after_seconds between 0 and 60,
    format('rate limit: retry_after should fall within the window, got %s', r3.retry_after_seconds);
end;
$$;

-- ── 4. memory_write backdates on INSERT but never moves created_at on UPDATE ─
-- The migration-support path added in 00009 (#69). This is the highest-value
-- assertion: the conflict-update branch must PRESERVE created_at (a creation
-- date never moves on a re-write) while advancing updated_at — even when a
-- different created_at is supplied on the second call.
do $$
declare
  v_id1 uuid; v_created1 timestamptz;
  v_id2 uuid;
  v_row memories%rowtype;
  v_backdate constant timestamptz := timestamptz '2020-01-01T00:00:00Z';
begin
  -- (a) INSERT with a backdated created_at sets BOTH created_at and updated_at.
  select id, created_at into v_id1, v_created1
    from memory_write('00000000-0000-0000-0000-0000000000e5', 'global', 'ca-key', 'v1',
                      '{}'::text[], null, null, v_backdate);
  select * into v_row from memories where id = v_id1;
  assert v_created1 = v_backdate,
    format('memory_write insert: returned created_at %s should equal the backdate', v_created1);
  assert v_row.created_at = v_backdate and v_row.updated_at = v_backdate,
    format('memory_write insert: created_at/updated_at should both be the backdate, got %s / %s',
           v_row.created_at, v_row.updated_at);

  -- (b) CONFLICT-UPDATE preserves created_at and advances updated_at, even
  --     though a *different* created_at is passed on the update.
  select id into v_id2
    from memory_write('00000000-0000-0000-0000-0000000000e5', 'global', 'ca-key', 'v2',
                      '{}'::text[], null, null, timestamptz '2010-06-06T00:00:00Z');
  select * into v_row from memories where id = v_id2;
  assert v_id2 = v_id1, 'memory_write conflict: should update the existing row, not insert a new one';
  assert v_row.value = 'v2', 'memory_write conflict: value should be updated to v2';
  assert v_row.created_at = v_backdate,
    format('memory_write conflict: created_at must NOT move on update (got %s, want %s)', v_row.created_at, v_backdate);
  assert v_row.updated_at > v_backdate,
    format('memory_write conflict: updated_at must advance past the backdate (got %s)', v_row.updated_at);
end;
$$;

-- ── 5. webhook_secrets: one active secret per (user, repo) + repo format ─────
-- Covers the partial unique index and the repo CHECK from 00008.
do $$
declare
  v_dup     boolean := false;
  v_nulldup boolean := false;
  v_badrepo boolean := false;
  hex64 constant text := repeat('a', 64); -- satisfies check(length(secret) = 64)
begin
  -- First active secret for (E, 'o/r'), plus a different repo for the same user.
  insert into webhook_secrets (user_id, secret, active, repo) values ('00000000-0000-0000-0000-0000000000e5', hex64, true, 'o/r');
  insert into webhook_secrets (user_id, secret, active, repo) values ('00000000-0000-0000-0000-0000000000e5', hex64, true, 'o/r2');

  -- A second ACTIVE secret for the same (user, repo) must violate the index.
  begin
    insert into webhook_secrets (user_id, secret, active, repo) values ('00000000-0000-0000-0000-0000000000e5', hex64, true, 'o/r');
  exception when unique_violation then
    v_dup := true;
  end;
  assert v_dup, 'webhook_secrets: a 2nd active secret for the same (user, repo) must violate the partial unique index';

  -- The legacy null-repo row folds via coalesce(repo,'') — one active per user.
  insert into webhook_secrets (user_id, secret, active) values ('00000000-0000-0000-0000-0000000000e5', hex64, true);
  begin
    insert into webhook_secrets (user_id, secret, active) values ('00000000-0000-0000-0000-0000000000e5', hex64, true);
  exception when unique_violation then
    v_nulldup := true;
  end;
  assert v_nulldup, 'webhook_secrets: two active null-repo rows for one user must collide via coalesce()';

  -- repo must be canonical lowercase owner/name (CHECK from 00008).
  begin
    insert into webhook_secrets (user_id, secret, active, repo) values ('00000000-0000-0000-0000-0000000000e5', hex64, true, 'BAD/UPPER');
  exception when check_violation then
    v_badrepo := true;
  end;
  assert v_badrepo, 'webhook_secrets: an uppercase repo must violate the repo-format CHECK';
end;
$$;

-- ── 6. memories.org_id FK: a bogus org_id must be rejected (00013) ──────────
do $$
declare v_fk_violation boolean := false;
begin
  begin
    insert into memories (user_id, org_id, scope, key, value)
    values (null, gen_random_uuid(), 'global', 'fk-bogus-key', 'v');
  exception when foreign_key_violation then
    v_fk_violation := true;
  end;
  assert v_fk_violation,
    'memories.org_id: an org_id not present in orgs must raise a foreign_key_violation';
end;
$$;

-- ── 7. orgs / org_members: role CHECK + membership-row RLS (00012) ──────────
-- User A and user D are members of a shared test org; user B stays a
-- non-member (used by section 8's read-widening assertions below).
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000f1', 'test-org', 'Test Org', '00000000-0000-0000-0000-0000000000a1');

insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d4', 'member');

do $$
declare v_bad_role boolean := false;
begin
  begin
    insert into org_members (org_id, user_id, role)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c3', 'superadmin');
  exception when check_violation then
    v_bad_role := true;
  end;
  assert v_bad_role, 'org_members: role must be constrained to owner|admin|member';
end;
$$;

-- Phase 3 (00019) widens rls_org_members_select from own-row-only to all
-- co-members of a shared org — user A should now see BOTH seeded rows for
-- org f1 (its own + user D's), not just its own. This supersedes the Phase 1
-- own-row-only assertion (a placeholder before invite/accept existed — see
-- plan.md Decisions); a non-member of f1 must still see none (AC-11).
do $$
declare v_co_members int; v_nonmember_sees int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select count(*) into v_co_members from org_members where org_id = '00000000-0000-0000-0000-0000000000f1';

  reset role;

  assert v_co_members = 2,
    format('org_members RLS: user A should see BOTH co-member rows (widened select), saw %s', v_co_members);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);

  select count(*) into v_nonmember_sees from org_members where org_id = '00000000-0000-0000-0000-0000000000f1';

  reset role;

  assert v_nonmember_sees = 0,
    format('org_members RLS: a non-member of org f1 must see no membership rows, saw %s', v_nonmember_sees);
end;
$$;

-- ── 8. Widened memories RLS: member sees org rows, non-member does not (00013) ─
-- The row is org-owned only (user_id null, org_id set) — visible to any
-- member of the org, to nobody else.
insert into memories (user_id, org_id, scope, key, value) values
  (null, '00000000-0000-0000-0000-0000000000f1', 'global', 'org-shared-key', 'shared value');

do $$
declare
  v_member_ids   uuid[];
  v_member_sees  int;
  v_other_member_sees int;
  v_nonmember_sees int;
begin
  select array_agg(org_id) into v_member_ids
    from lorekit_member_org_ids('00000000-0000-0000-0000-0000000000a1') as org_id;
  assert v_member_ids = array['00000000-0000-0000-0000-0000000000f1']::uuid[],
    format('lorekit_member_org_ids: user A should resolve to org f1 only, got %s', v_member_ids);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select count(*) into v_member_sees from memories where key = 'org-shared-key';
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  select count(*) into v_other_member_sees from memories where key = 'org-shared-key';
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_nonmember_sees from memories where key = 'org-shared-key';
  reset role;

  assert v_member_sees = 1, format('org RLS: member A should see the org-owned row, saw %s', v_member_sees);
  assert v_other_member_sees = 1, format('org RLS: member D should see the org-owned row, saw %s', v_other_member_sees);
  assert v_nonmember_sees = 0, format('org RLS: non-member B must NOT see the org-owned row, saw %s', v_nonmember_sees);
end;
$$;

-- The unsafe client-asserted JWT claim policy must be gone: forging an
-- org_id claim for a non-member must NOT grant visibility (membership-join
-- only, never the JWT claim itself — this is the exact vulnerability 00013
-- replaces).
do $$
declare v_forged int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","org_id":"00000000-0000-0000-0000-0000000000f1"}', true);
  select count(*) into v_forged from memories where key = 'org-shared-key';
  reset role;

  assert v_forged = 0,
    'org RLS: a forged org_id JWT claim must not grant visibility';
end;
$$;

-- ── 9. Org-aware unique arbiter: org / personal / service partitions never
--       collide with each other, but do collide within themselves (00014) ───
do $$
declare v_org_dup boolean := false;
begin
  insert into memories (user_id, org_id, scope, key, value) values
    (null, '00000000-0000-0000-0000-0000000000f1', 'global', 'arb-key', 'v1');
  begin
    insert into memories (user_id, org_id, scope, key, value) values
      (null, '00000000-0000-0000-0000-0000000000f1', 'global', 'arb-key', 'v2');
  exception when unique_violation then
    v_org_dup := true;
  end;
  assert v_org_dup, 'arbiter: two org rows sharing (org_id, scope, key) must collide';
end;
$$;

do $$
begin
  -- A personal row and a service row sharing (scope, key) with the org row
  -- inserted above must NOT collide with it, or with each other — the three
  -- partial indexes partition on org_id/user_id nullability.
  insert into memories (user_id, org_id, scope, key, value) values
    ('00000000-0000-0000-0000-0000000000a1', null, 'global', 'arb-key', 'personal');
  insert into memories (user_id, org_id, scope, key, value) values
    (null, null, 'global', 'arb-key', 'service');
  -- Reaching here without an exception is the assertion.
end;
$$;

-- ── 10. memory_write stays personal-only: org_id is always NULL (00014) ─────
do $$
declare v_row memories%rowtype;
begin
  select * into v_row from memories where id = (
    select id from memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'phase1-write-key', 'v', '{}'::text[])
  );
  assert v_row.org_id is null,
    'memory_write: Phase 1 writes must always leave org_id NULL (writes stay personal-only)';
end;
$$;

-- ── 11. audit_log search indexes present (00012) ────────────────────────────
-- Covers the pg_trgm extension + both new indexes: index presence isn't a
-- behavior the app-layer unit tests can assert, so this proves the migration
-- actually created what packages/web/src/lib/pagination/ (name search +
-- keyset seek) relies on for performance.
do $$
declare
  v_trgm_ext   boolean;
  v_trgm_idx   boolean;
  v_keyset_idx boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_trgm') into v_trgm_ext;
  assert v_trgm_ext, 'audit_log search: pg_trgm extension must be enabled';

  select exists (
    select 1 from pg_indexes
    where tablename = 'audit_log' and indexname = 'audit_log_target_trgm_idx'
  ) into v_trgm_idx;
  assert v_trgm_idx, 'audit_log search: GIN trigram index on target must exist';

  select exists (
    select 1 from pg_indexes
    where tablename = 'audit_log' and indexname = 'audit_log_user_created_id_idx'
  ) into v_keyset_idx;
  assert v_keyset_idx, 'audit_log search: (user_id, created_at desc, id) keyset-covering index must exist';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Phase 2 (org-owned writes) — supabase/migrations/00015-00018.
-- A dedicated 'phase2-org' (f2) with all four roles keeps these assertions
-- self-contained instead of coupling to test-org's (f1) row counts above.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 11. Phase 2: org f2 seeded with all four roles (00015) ──────────────────
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000f2', 'phase2-org', 'Phase 2 Org', '00000000-0000-0000-0000-0000000000a1');

insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d4', 'member'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c3', 'viewer'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e5', 'admin');

do $$
begin
  perform 1 from org_members where org_id = '00000000-0000-0000-0000-0000000000f2' and role = 'viewer';
  assert found, 'org_members: viewer role insert should succeed (role CHECK must admit viewer)';
end;
$$;

-- lorekit_org_can capability matrix (AC-8): viewer=none; member=write/archive/
-- restore; admin & owner=+hard_delete. This is the SOLE capability source —
-- no TS re-derivation of this matrix exists (see org-permissions.ts header).
do $$
declare
  v_owner     constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_member    constant uuid := '00000000-0000-0000-0000-0000000000d4';
  v_viewer    constant uuid := '00000000-0000-0000-0000-0000000000c3';
  v_admin     constant uuid := '00000000-0000-0000-0000-0000000000e5';
  v_org       constant uuid := '00000000-0000-0000-0000-0000000000f2';
  v_nonmember constant uuid := '00000000-0000-0000-0000-0000000000b2';
begin
  assert lorekit_org_can(v_owner, v_org, 'write'), 'owner should have write capability';
  assert lorekit_org_can(v_owner, v_org, 'hard_delete'), 'owner should have hard_delete capability';
  assert lorekit_org_can(v_admin, v_org, 'write'), 'admin should have write capability';
  assert lorekit_org_can(v_admin, v_org, 'hard_delete'), 'admin should have hard_delete capability';
  assert lorekit_org_can(v_member, v_org, 'write'), 'member should have write capability';
  assert lorekit_org_can(v_member, v_org, 'archive'), 'member should have archive capability';
  assert lorekit_org_can(v_member, v_org, 'restore'), 'member should have restore capability';
  assert not lorekit_org_can(v_member, v_org, 'hard_delete'), 'member must NOT have hard_delete capability';
  assert not lorekit_org_can(v_viewer, v_org, 'write'), 'viewer must NOT have write capability';
  assert not lorekit_org_can(v_viewer, v_org, 'archive'), 'viewer must NOT have archive capability';
  assert not lorekit_org_can(v_viewer, v_org, 'hard_delete'), 'viewer must NOT have hard_delete capability';
  assert not lorekit_org_can(v_nonmember, v_org, 'write'), 'a non-member must NOT have write capability';
end;
$$;

-- ── 12. memory_write: org-write authorization is derived, not caller-trusted (AC-1) ─
do $$
declare
  v_id uuid;
  v_row memories%rowtype;
  v_denied_viewer boolean := false;
  v_denied_nonmember boolean := false;
begin
  -- A write-capable member (owner) writes org-owned lore: org_id set, user_id
  -- NULL. Two statements, not one nested subquery: a single SQL statement's
  -- snapshot does not reliably see a row inserted by a volatile function
  -- called from within its own WHERE clause (see §4/§10's identical shape).
  select id into v_id from memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-write-key', 'v1',
                                        '{}'::text[], null, null, null, 'phase2-org');
  select * into v_row from memories where id = v_id;
  assert v_row.org_id = '00000000-0000-0000-0000-0000000000f2',
    format('memory_write org branch: org_id should be phase2-org, got %s', v_row.org_id);
  assert v_row.user_id is null,
    'memory_write org branch: user_id must be NULL on an org-owned row';

  -- A viewer is denied.
  begin
    perform memory_write('00000000-0000-0000-0000-0000000000c3', 'global', 'p2-write-viewer-key', 'v',
                          '{}'::text[], null, null, null, 'phase2-org');
  exception when sqlstate 'LK002' then
    v_denied_viewer := true;
  end;
  assert v_denied_viewer, 'memory_write: a viewer must be denied an org write with LK002';

  -- A non-member is denied.
  begin
    perform memory_write('00000000-0000-0000-0000-0000000000b2', 'global', 'p2-write-nonmember-key', 'v',
                          '{}'::text[], null, null, null, 'phase2-org');
  exception when sqlstate 'LK002' then
    v_denied_nonmember := true;
  end;
  assert v_denied_nonmember, 'memory_write: a non-member must be denied an org write with LK002';

  assert not exists (select 1 from memories where key = 'p2-write-viewer-key'),
    'memory_write: a denied viewer write must not write any row';
  assert not exists (select 1 from memories where key = 'p2-write-nonmember-key'),
    'memory_write: a denied non-member write must not write any row';
end;
$$;

-- ── 13. memory_write: an omitted p_org_slug stays personal-only (AC-2) ──────
do $$
declare v_id uuid; v_row memories%rowtype;
begin
  select id into v_id from memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-personal-key', 'v');
  select * into v_row from memories where id = v_id;
  assert v_row.org_id is null,
    'memory_write: a call with no p_org_slug must leave org_id NULL';
  assert v_row.user_id = '00000000-0000-0000-0000-0000000000a1',
    'memory_write: a personal write must set user_id to the writer';
end;
$$;

-- ── 13b. memory_write: org-scoped write succeeds under RLS for a real JWT
-- caller, not just a superuser/service-role test harness (regression) ───────
--
-- Every prior org-write assertion above (§12) calls memory_write() directly
-- as the test's own (superuser) role, which bypasses Row Level Security
-- entirely — so it never exercised the path a real dashboard/user-session
-- caller goes through. That gap hid a bug: the org-write branch inserts
-- `user_id = null` for an org-owned row, and `rls_insert` (00001) only allows
-- `user_id = auth.uid() or auth.role() = 'service_role'`. Without
-- `security definer`, memory_write ran as the CALLER's role, so an
-- `authenticated` JWT caller writing to an org got "new row violates row-level
-- security policy for table memories" even though lorekit_org_can() already
-- approved the write. This reproduces that path under `set local role
-- authenticated` (the same technique as §1/§7/§8) and asserts it now succeeds.
do $$
declare
  v_id uuid;
  v_row memories%rowtype;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select id into v_id from memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-rls-write-key', 'v1',
                                        '{}'::text[], null, null, null, 'phase2-org');

  reset role;

  assert v_id is not null,
    'memory_write: an org-scoped write from an authenticated JWT caller must not be rejected by RLS';

  select * into v_row from memories where id = v_id;
  assert v_row.org_id = '00000000-0000-0000-0000-0000000000f2',
    format('memory_write org branch (RLS caller): org_id should be phase2-org, got %s', v_row.org_id);
  assert v_row.user_id is null,
    'memory_write org branch (RLS caller): user_id must be NULL on an org-owned row';
end;
$$;

-- ── 14. Author attribution: created_by/updated_by + clobber preservation (AC-3) ─
-- The whole test file runs inside one transaction, and now() is STABLE (frozen
-- at transaction start) for its duration — pg_sleep() cannot make a later
-- now() call return a later value. So, exactly like §4's backdate technique,
-- this proves ordering with an explicit backdated p_created_at on the FIRST
-- write rather than a wall-clock gap: updated_at on clobber is set to the
-- (frozen, but "now") transaction time, which is provably later than an
-- old backdate.
do $$
declare
  v_id uuid;
  v_row memories%rowtype;
  v_backdate constant timestamptz := timestamptz '2020-01-01T00:00:00Z';
begin
  -- Owner (A) creates the org row with a backdated created_at.
  select id into v_id from memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-clobber-key', 'v1',
                                        '{}'::text[], null, null, v_backdate, 'phase2-org');
  select * into v_row from memories where id = v_id;
  assert v_row.created_by = '00000000-0000-0000-0000-0000000000a1'
     and v_row.updated_by = '00000000-0000-0000-0000-0000000000a1',
    'memory_write: a fresh org write should set created_by = updated_by = writer';
  assert v_row.created_at = v_backdate,
    format('memory_write org insert: created_at should be the backdate, got %s', v_row.created_at);

  -- A different write-capable member (admin E) clobbers the same (org_id, scope, key).
  select id into v_id from memory_write('00000000-0000-0000-0000-0000000000e5', 'global', 'p2-clobber-key', 'v2',
                                        '{}'::text[], null, null, null, 'phase2-org');
  select * into v_row from memories where id = v_id;
  assert v_row.created_by = '00000000-0000-0000-0000-0000000000a1',
    'memory_write org clobber: created_by must be preserved as the original writer';
  assert v_row.created_at = v_backdate,
    'memory_write org clobber: created_at must not move on clobber';
  assert v_row.updated_by = '00000000-0000-0000-0000-0000000000e5',
    'memory_write org clobber: updated_by must advance to the clobbering writer';
  assert v_row.updated_at > v_backdate,
    'memory_write org clobber: updated_at must advance past the original (backdated) created_at';
  assert v_row.value = 'v2', 'memory_write org clobber: value should be updated';
end;
$$;

-- ── 15. Author columns: personal write vs. service write (AC-4) ─────────────
do $$
declare v_id uuid; v_personal memories%rowtype; v_service memories%rowtype;
begin
  select * into v_personal from memories where key = 'p2-personal-key';
  assert v_personal.created_by = '00000000-0000-0000-0000-0000000000a1'
     and v_personal.updated_by = '00000000-0000-0000-0000-0000000000a1',
    'memory_write: a personal write should set created_by = updated_by = writer';

  select id into v_id from memory_write(null, 'global', 'p2-service-key', 'v');
  select * into v_service from memories where id = v_id;
  assert v_service.created_by is null and v_service.updated_by is null,
    'memory_write: a service-role write must leave created_by/updated_by NULL';
end;
$$;

-- ── 16. Tenant-keyed cap: org writes count against the org, never service-exempt (AC-5) ─
-- phase2-org (f2) already carries exactly 2 active org rows at this point
-- (p2-write-key from §12, p2-clobber-key from §14) — capping it at 2 means
-- the next org write must be rejected. If the org branch ever regressed to
-- fall through the user_id-IS-NULL service exemption (org rows always have
-- user_id NULL), this insert would wrongly succeed instead of raising LK001.
do $$
declare v_blocked boolean := false;
begin
  insert into org_limits (org_id, max_memories)
  values ('00000000-0000-0000-0000-0000000000f2', 2);

  begin
    perform memory_write('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-cap-key', 'v',
                          '{}'::text[], null, null, null, 'phase2-org');
  exception when sqlstate 'LK001' then
    v_blocked := true;
  end;
  assert v_blocked,
    'org cap: the 3rd org write against max_memories=2 must raise SQLSTATE LK001';
  assert not exists (select 1 from memories where key = 'p2-cap-key'),
    'org cap: the rejected write must not have inserted a row';
end;
$$;

-- ── 17. Org writes never consume the writer's personal cap (AC-6) ───────────
-- Member D (default 1000 personal limit, no override) writes an org-owned row
-- to test-org (f1, uncapped) — this must not appear in D's personal count.
do $$
declare v_personal_count_before int; v_personal_count_after int;
begin
  select count(*) into v_personal_count_before
    from memories where user_id = '00000000-0000-0000-0000-0000000000d4' and archived_at is null;

  perform memory_write('00000000-0000-0000-0000-0000000000d4', 'global', 'p2-member-org-write-key', 'v',
                        '{}'::text[], null, null, null, 'test-org');

  select count(*) into v_personal_count_after
    from memories where user_id = '00000000-0000-0000-0000-0000000000d4' and archived_at is null;

  assert v_personal_count_after = v_personal_count_before,
    format('org write: writer D''s personal memory count must be unaffected (before=%s after=%s)',
           v_personal_count_before, v_personal_count_after);
  assert exists (
    select 1 from memories
     where key = 'p2-member-org-write-key' and org_id = '00000000-0000-0000-0000-0000000000f1'
  ), 'org write: the row should exist under org f1, org-owned';
end;
$$;

-- ── 18. Role-gated memory_delete: viewer/member/admin + personal unchanged (AC-9) ─
do $$
declare
  v_denied_viewer boolean := false;
  v_denied_member_hard boolean := false;
  r record;
begin
  -- Lift phase2-org's cap (set to 2 in §16) so this section's direct insert
  -- doesn't trip the cap trigger independently of what it's testing.
  update org_limits set max_memories = 10 where org_id = '00000000-0000-0000-0000-0000000000f2';

  insert into memories (org_id, scope, key, value) values
    ('00000000-0000-0000-0000-0000000000f2', 'global', 'p2-del-key', 'v');

  -- Since 00046, memory_delete resolves the org capability check against the
  -- EFFECTIVE actor, honouring a caller-supplied p_user_id only on a
  -- service-role connection — which is exactly how the edge api_key path
  -- invokes the org branch (a service-role client naming the token owner).
  -- Adopt that context so each named role-holder (viewer c3 / member d4 /
  -- admin e5) is authorized as itself; without it the actor resolves to a
  -- stale auth.uid() and every capability check denies.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- viewer denied soft-archive
  begin
    perform memory_delete('00000000-0000-0000-0000-0000000000c3', 'phase2-org', 'global', 'p2-del-key', false);
  exception when sqlstate 'LK002' then
    v_denied_viewer := true;
  end;
  assert v_denied_viewer, 'memory_delete: a viewer must be denied a soft-archive with LK002';

  -- member soft-archives OK
  select * into r from memory_delete('00000000-0000-0000-0000-0000000000d4', 'phase2-org', 'global', 'p2-del-key', false);
  assert r.archived and not r.deleted,
    format('memory_delete: a member soft-archive should succeed (archived=%s deleted=%s)', r.archived, r.deleted);

  -- member denied hard-delete
  begin
    perform memory_delete('00000000-0000-0000-0000-0000000000d4', 'phase2-org', 'global', 'p2-del-key', true);
  exception when sqlstate 'LK002' then
    v_denied_member_hard := true;
  end;
  assert v_denied_member_hard, 'memory_delete: a member must be denied a hard-delete with LK002';

  -- admin hard-deletes OK
  select * into r from memory_delete('00000000-0000-0000-0000-0000000000e5', 'phase2-org', 'global', 'p2-del-key', true);
  assert r.deleted and not r.archived,
    format('memory_delete: an admin hard-delete should succeed (deleted=%s archived=%s)', r.deleted, r.archived);
  assert not exists (select 1 from memories where key = 'p2-del-key'),
    'memory_delete: an admin hard-delete should actually remove the row';

  -- Personal delete (no org selector) is unchanged: mirrors the pre-Phase-2
  -- .eq(user_id, ...) soft-archive behavior.
  insert into memories (user_id, scope, key, value) values
    ('00000000-0000-0000-0000-0000000000a1', 'global', 'p2-personal-del-key', 'v');
  select * into r from memory_delete('00000000-0000-0000-0000-0000000000a1', null, 'global', 'p2-personal-del-key', false);
  assert r.archived and not r.deleted,
    'memory_delete: a personal soft-archive (no org selector) should behave as before';

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Phase 3 (org management + invites + audit) — supabase/migrations/00019-00021.
-- All 10 management RPCs resolve the actor as auth.uid() (not a p_user_id
-- parameter — see 00020's header comment), so every call below runs under
-- `set local role authenticated` with forged request.jwt.claims, exactly
-- like the RLS assertions in §7/§8 above.
-- ═════════════════════════════════════════════════════════════════════════

-- Two fresh identities dedicated to the invite/accept scenarios below: G is
-- the genuine invitee ("C" in plan.md's accept-binds-to-caller narrative), H
-- is an unrelated user who must NOT be able to accept an invite addressed to G.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000f6', 'authenticated', 'authenticated', 'lk-mig-g@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000f7', 'authenticated', 'authenticated', 'lk-mig-h@test.local', now(), now());

-- ── 19. lorekit_org_create: atomic org+owner create; duplicate slug denied (AC-1) ─
do $$
declare
  v_org_id uuid;
  v_owner_count int;
  v_dup boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f6","role":"authenticated","email":"lk-mig-g@test.local"}', true);

  select lorekit_org_create('phase3-atomic-org', 'Phase 3 Atomic Org') into v_org_id;

  select count(*) into v_owner_count from org_members
   where org_id = v_org_id and user_id = '00000000-0000-0000-0000-0000000000f6' and role = 'owner';
  assert v_owner_count = 1,
    'lorekit_org_create: the creator must be inserted as owner atomically with the org row';
  assert exists (select 1 from orgs where id = v_org_id and slug = 'phase3-atomic-org'),
    'lorekit_org_create: the orgs row must exist with the given slug';

  begin
    perform lorekit_org_create('phase3-atomic-org', 'Duplicate Slug Org');
  exception when unique_violation then
    v_dup := true;
  end;
  assert v_dup, 'lorekit_org_create: a duplicate slug must raise a unique_violation';

  reset role;
end;
$$;

-- ── 20. lorekit_org_rename / lorekit_org_delete: owner/admin gating (AC-2) ──
-- Fresh 'phase3-org' (f3) with owner A, admin E, member D, viewer C — reused
-- by sections 21-27 below.
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000f3', 'phase3-org', 'Phase 3 Org', '00000000-0000-0000-0000-0000000000a1');

insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e5', 'admin'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000d4', 'member'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', 'viewer');

do $$
declare
  v_denied_member boolean := false;
  v_denied_admin_delete boolean := false;
begin
  -- A member (D) cannot rename or delete.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  begin
    perform lorekit_org_rename('00000000-0000-0000-0000-0000000000f3', 'Hijacked Name');
  exception when sqlstate 'LK002' then
    v_denied_member := true;
  end;
  reset role;
  assert v_denied_member, 'lorekit_org_rename: a member must be denied with LK002';

  -- An admin (E) may rename.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
  perform lorekit_org_rename('00000000-0000-0000-0000-0000000000f3', 'Phase 3 Org Renamed');
  reset role;
  assert (select name from orgs where id = '00000000-0000-0000-0000-0000000000f3') = 'Phase 3 Org Renamed',
    'lorekit_org_rename: an admin rename should apply';

  -- An admin (E) may NOT delete — owner-only.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
  begin
    perform lorekit_org_delete('00000000-0000-0000-0000-0000000000f3');
  exception when sqlstate 'LK002' then
    v_denied_admin_delete := true;
  end;
  reset role;
  assert v_denied_admin_delete, 'lorekit_org_delete: an admin must be denied with LK002 (owner-only)';
end;
$$;

-- ── 21. org_invites: role/status/identity CHECKs + pending partial-unique (AC-4) ─
do $$
declare
  v_bad_role boolean := false;
  v_owner_role boolean := false;
  v_no_identity boolean := false;
  v_bad_status boolean := false;
  v_pending_dup boolean := false;
begin
  begin
    insert into org_invites (org_id, invitee_email, role) values
      ('00000000-0000-0000-0000-0000000000f3', 'x@test.local', 'superadmin');
  exception when check_violation then v_bad_role := true; end;
  assert v_bad_role, 'org_invites: role must be constrained to admin|member|viewer';

  begin
    insert into org_invites (org_id, invitee_email, role) values
      ('00000000-0000-0000-0000-0000000000f3', 'x@test.local', 'owner');
  exception when check_violation then v_owner_role := true; end;
  assert v_owner_role, 'org_invites: role must NOT admit owner (ownership is non-transferable)';

  begin
    insert into org_invites (org_id, role) values
      ('00000000-0000-0000-0000-0000000000f3', 'member');
  exception when check_violation then v_no_identity := true; end;
  assert v_no_identity, 'org_invites: a row with neither email nor handle must be rejected';

  begin
    insert into org_invites (org_id, invitee_email, role, status) values
      ('00000000-0000-0000-0000-0000000000f3', 'x@test.local', 'member', 'bogus');
  exception when check_violation then v_bad_status := true; end;
  assert v_bad_status, 'org_invites: status must be constrained to pending|accepted|declined|revoked';

  insert into org_invites (org_id, invitee_email, role) values
    ('00000000-0000-0000-0000-0000000000f3', 'dup@test.local', 'member');
  begin
    insert into org_invites (org_id, invitee_email, role) values
      ('00000000-0000-0000-0000-0000000000f3', 'dup@test.local', 'viewer');
  exception when unique_violation then v_pending_dup := true; end;
  assert v_pending_dup, 'org_invites: two pending invites for the same (org, email) must collide';
end;
$$;

-- ── 22. lorekit_org_invite: non-admin denied, owner/admin creates pending row (AC-5) ─
do $$
declare
  v_denied_member boolean := false;
  v_denied_viewer boolean := false;
  v_invite_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  begin
    perform lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'nope@test.local', null, 'member');
  exception when sqlstate 'LK002' then v_denied_member := true; end;
  reset role;
  assert v_denied_member, 'lorekit_org_invite: a member must be denied with LK002';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
  begin
    perform lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'nope2@test.local', null, 'member');
  exception when sqlstate 'LK002' then v_denied_viewer := true; end;
  reset role;
  assert v_denied_viewer, 'lorekit_org_invite: a viewer must be denied with LK002';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'someone-else@test.local', null, 'member')
    into v_invite_id;
  reset role;

  assert exists (
    select 1 from org_invites
     where id = v_invite_id and status = 'pending' and invitee_email = 'someone-else@test.local'
  ), 'lorekit_org_invite: owner invite should create a pending row addressed to the invitee';
end;
$$;

-- ── 23. lorekit_org_invite_accept binds to the CALLER, not the invited string (AC-6) ─
do $$
declare
  v_invite_id uuid;
  v_denied_wrong_user boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'lk-mig-g@test.local', null, 'member')
    into v_invite_id;
  reset role;

  -- User H (not the invitee) tries to accept G's invite — must be denied and
  -- must create no membership for G or H.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","email":"lk-mig-h@test.local"}', true);
  begin
    perform lorekit_org_invite_accept(v_invite_id);
  exception when sqlstate 'LK002' then v_denied_wrong_user := true; end;
  reset role;
  assert v_denied_wrong_user, 'lorekit_org_invite_accept: a different authenticated user (D/H) must be denied with LK002';
  assert not exists (
    select 1 from org_members where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000f7'
  ), 'lorekit_org_invite_accept: the wrongful accept attempt must create no membership';
  assert (select status from org_invites where id = v_invite_id) = 'pending',
    'lorekit_org_invite_accept: a denied accept must leave the invite pending';

  -- User G (the genuine invitee, matched on verified JWT email) accepts.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f6","role":"authenticated","email":"lk-mig-g@test.local"}', true);
  perform lorekit_org_invite_accept(v_invite_id);
  reset role;

  assert exists (
    select 1 from org_members
     where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000f6' and role = 'member'
  ), 'lorekit_org_invite_accept: G accepting its own invite must create org_members(org,G,role)';
  assert (select status from org_invites where id = v_invite_id) = 'accepted',
    'lorekit_org_invite_accept: a successful accept must flip status to accepted';
end;
$$;

-- ── 24. declineInvite / revokeInvite / accept-after-non-pending (AC-7) ──────
do $$
declare
  v_decline_id uuid;
  v_revoke_id uuid;
  v_denied_after_decline boolean := false;
  v_denied_after_revoke boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'lk-mig-h@test.local', null, 'viewer') into v_decline_id;
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', null, 'octocat-h', 'viewer') into v_revoke_id;
  reset role;

  -- H declines its own invite.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","email":"lk-mig-h@test.local"}', true);
  perform lorekit_org_invite_decline(v_decline_id);
  reset role;
  assert (select status from org_invites where id = v_decline_id) = 'declined',
    'lorekit_org_invite_decline: status should flip to declined';
  assert not exists (
    select 1 from org_members where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000f7'
  ), 'lorekit_org_invite_decline: declining must create no membership';

  -- Owner revokes the handle-addressed invite.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform lorekit_org_invite_revoke(v_revoke_id);
  reset role;
  assert (select status from org_invites where id = v_revoke_id) = 'revoked',
    'lorekit_org_invite_revoke: status should flip to revoked';

  -- A revoked/declined invite can no longer be accepted.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","email":"lk-mig-h@test.local"}', true);
  begin
    perform lorekit_org_invite_accept(v_decline_id);
  exception when sqlstate 'LK002' then v_denied_after_decline := true; end;
  reset role;
  assert v_denied_after_decline, 'lorekit_org_invite_accept: accepting a declined invite must raise LK002';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","user_metadata":{"user_name":"octocat-h"}}', true);
  begin
    perform lorekit_org_invite_accept(v_revoke_id);
  exception when sqlstate 'LK002' then v_denied_after_revoke := true; end;
  reset role;
  assert v_denied_after_revoke, 'lorekit_org_invite_accept: accepting a revoked invite must raise LK002';
end;
$$;

-- ── 25. lorekit_org_member_remove: non-admin denied; last-owner + admin-vs-owner (AC-8) ─
do $$
declare
  v_denied_member boolean := false;
  v_denied_last_owner boolean := false;
  v_denied_admin_removes_owner boolean := false;
begin
  -- A member (D) cannot remove anyone.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_remove('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f6');
  exception when sqlstate 'LK002' then v_denied_member := true; end;
  reset role;
  assert v_denied_member, 'lorekit_org_member_remove: a non-admin/non-owner must be denied with LK002';

  -- An admin (E) removes a plain member (G, who accepted its invite in §23) — allowed.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
  perform lorekit_org_member_remove('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f6');
  reset role;
  assert not exists (
    select 1 from org_members where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000f6'
  ), 'lorekit_org_member_remove: an admin removing a member should succeed';

  -- An admin (E) may NOT remove the owner (A).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_remove('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1');
  exception when sqlstate 'LK002' then v_denied_admin_removes_owner := true; end;
  reset role;
  assert v_denied_admin_removes_owner, 'lorekit_org_member_remove: an admin removing the owner must raise LK002';

  -- The owner (A, sole owner of f3) cannot remove themself.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_remove('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1');
  exception when sqlstate 'LK002' then v_denied_last_owner := true; end;
  reset role;
  assert v_denied_last_owner, 'lorekit_org_member_remove: removing the last owner must raise LK002';
end;
$$;

-- ── 26. lorekit_org_member_role: gated; cannot assign owner; last-owner demote denied (AC-9) ─
do $$
declare
  v_denied_member boolean := false;
  v_denied_assign_owner boolean := false;
  v_denied_demote_last_owner boolean := false;
begin
  -- A member (D) cannot change anyone's role.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_role('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', 'admin');
  exception when sqlstate 'LK002' then v_denied_member := true; end;
  reset role;
  assert v_denied_member, 'lorekit_org_member_role: a non-admin/non-owner must be denied with LK002';

  -- An admin (E) may promote the viewer (C) to member — a permitted change applies.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
  perform lorekit_org_member_role('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', 'member');
  reset role;
  assert (select role from org_members where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000c3') = 'member',
    'lorekit_org_member_role: a permitted role change (viewer -> member) should apply';

  -- Nobody can assign 'owner' via changeMemberRole.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_role('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', 'owner');
  exception when sqlstate 'LK002' then v_denied_assign_owner := true; end;
  reset role;
  assert v_denied_assign_owner, 'lorekit_org_member_role: assigning owner must raise LK002 (ownership is not transferable)';

  -- The last owner (A) cannot be demoted.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    perform lorekit_org_member_role('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'admin');
  exception when sqlstate 'LK002' then v_denied_demote_last_owner := true; end;
  reset role;
  assert v_denied_demote_last_owner, 'lorekit_org_member_role: demoting the last owner must raise LK002';
end;
$$;

-- ── 27. lorekit_org_leave: member leaves; last owner cannot leave (AC-10) ───
do $$
declare v_denied_last_owner boolean := false;
begin
  -- Member D leaves voluntarily.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  perform lorekit_org_leave('00000000-0000-0000-0000-0000000000f3');
  reset role;
  assert not exists (
    select 1 from org_members where org_id = '00000000-0000-0000-0000-0000000000f3' and user_id = '00000000-0000-0000-0000-0000000000d4'
  ), 'lorekit_org_leave: a member leaving should remove their own membership row';

  -- The sole remaining owner (A) cannot leave.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    perform lorekit_org_leave('00000000-0000-0000-0000-0000000000f3');
  exception when sqlstate 'LK002' then v_denied_last_owner := true; end;
  reset role;
  assert v_denied_last_owner, 'lorekit_org_leave: the last owner leaving must raise LK002';
end;
$$;

-- ── 28. org_invites RLS: manager sees all, invitee sees own pending, others see none (AC-11) ─
do $$
declare
  v_new_invite_id uuid;
  v_manager_sees int;
  v_invitee_sees int;
  v_nonmanager_sees int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'lk-mig-g@test.local', null, 'member') into v_new_invite_id;
  reset role;

  -- Owner/admin (manager) sees the org's invites.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select count(*) into v_manager_sees from org_invites where id = v_new_invite_id;
  reset role;
  assert v_manager_sees = 1, 'org_invites RLS: an owner/admin (manager) must see the invite';

  -- The invitee (G, matched on verified JWT email) sees the pending invite
  -- addressed to it.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f6","role":"authenticated","email":"lk-mig-g@test.local"}', true);
  select count(*) into v_invitee_sees from org_invites where id = v_new_invite_id;
  reset role;
  assert v_invitee_sees = 1, 'org_invites RLS: the invitee must see the pending invite addressed to it';

  -- A non-invitee, non-manager (member D, now removed from f3, and a total
  -- stranger to this invite) sees nothing.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","email":"lk-mig-h@test.local"}', true);
  select count(*) into v_nonmanager_sees from org_invites where id = v_new_invite_id;
  reset role;
  assert v_nonmanager_sees = 0, 'org_invites RLS: a non-invitee non-manager must see no invite';
end;
$$;

-- ── 29. audit_log CHECK admits all 10 org actions; a bogus action is still rejected (AC-12) ─
do $$
declare v_bogus_rejected boolean := false;
begin
  insert into audit_log (user_id, action, resource_type, resource_id) values
    ('00000000-0000-0000-0000-0000000000a1', 'org.create', 'org', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'org.rename', 'org', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'org.delete', 'org', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.invite', 'org_invite', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.accept', 'org_invite', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.decline', 'org_invite', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.revoke', 'org_invite', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.remove', 'org_member', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.role_change', 'org_member', '00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000a1', 'member.leave', 'org_member', '00000000-0000-0000-0000-0000000000f3');

  begin
    insert into audit_log (user_id, action) values ('00000000-0000-0000-0000-0000000000a1', 'org.frobnicate');
  exception when check_violation then v_bogus_rejected := true; end;
  assert v_bogus_rejected, 'audit_log: a bogus action must still be rejected by the widened CHECK';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Phase 4 dashboard-UX addition — supabase/migrations/00024 (reverses
-- plan.md org-sharing-phase-4-dashboard Decision D1: real member identities
-- instead of a bare user_id for other members).
-- ═════════════════════════════════════════════════════════════════════════

-- ── 30. lorekit_org_members_list: member sees co-members' real handles;
--       non-member sees nothing (Phase 4 addition, 00024) ────────────────────
-- Reuses phase3-org (f3), whose final membership at this point in the file is
-- owner A, admin E, member C (D left in §27; G was removed in §25; C was
-- promoted viewer->member in §26).
update auth.users set raw_user_meta_data = '{"user_name":"owner-a","avatar_url":"https://avatars.example/a.png"}'::jsonb
  where id = '00000000-0000-0000-0000-0000000000a1';
update auth.users set raw_user_meta_data = '{"user_name":"admin-e","avatar_url":"https://avatars.example/e.png"}'::jsonb
  where id = '00000000-0000-0000-0000-0000000000e5';

do $$
declare
  v_member_row_count int;
  v_owner_handle text;
  v_owner_avatar text;
  v_nonmember_row_count int;
begin
  -- Member C (of phase3-org, f3) sees all remaining co-members, including the
  -- owner's real GitHub handle + avatar — not just a bare user_id (the exact
  -- gap plan.md D1 deferred and this migration closes).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
  select count(*) into v_member_row_count from lorekit_org_members_list('00000000-0000-0000-0000-0000000000f3');
  select handle, avatar_url into v_owner_handle, v_owner_avatar
    from lorekit_org_members_list('00000000-0000-0000-0000-0000000000f3')
    where user_id = '00000000-0000-0000-0000-0000000000a1';
  reset role;

  assert v_member_row_count = 3,
    format('lorekit_org_members_list: a member should see all 3 remaining co-members of phase3-org, saw %s', v_member_row_count);
  assert v_owner_handle = 'owner-a',
    format('lorekit_org_members_list: a member should resolve the owner''s real GitHub handle, saw %s', v_owner_handle);
  assert v_owner_avatar = 'https://avatars.example/a.png',
    'lorekit_org_members_list: a member should resolve the owner''s avatar_url';

  -- A non-member (B) of phase3-org gets NOTHING back — never leaks
  -- membership of an org the caller doesn't belong to.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_nonmember_row_count from lorekit_org_members_list('00000000-0000-0000-0000-0000000000f3');
  reset role;
  assert v_nonmember_row_count = 0,
    'lorekit_org_members_list: a non-member must see no rows for an org they do not belong to';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Safe org deletion — soft-delete + retention + purge (00025)
-- ═════════════════════════════════════════════════════════════════════════

-- Fresh 'sod-org' (f9) with owner A + member B and two org-owned memories,
-- isolated from the phase-3 fixtures above so soft-delete/purge assertions
-- don't perturb other sections.
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000f9', 'sod-org', 'Safe-Delete Org', '00000000-0000-0000-0000-0000000000a1');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000b2', 'member');
insert into memories (user_id, org_id, scope, key, value) values
  (null, '00000000-0000-0000-0000-0000000000f9', 'repo::acme/sod', 'sod-1', 'v'),
  (null, '00000000-0000-0000-0000-0000000000f9', 'repo::acme/sod', 'sod-2', 'v');

-- ── 31. Soft-delete hides the org AND its memories from a member's reads ─────
do $$
declare
  v_visible_before boolean;
  v_visible_after boolean;
  v_mem_before int;
  v_mem_after int;
  v_deleted_at timestamptz;
begin
  -- Before soft-delete: member B sees f9 in their membership set and can read
  -- both org-owned memories.
  v_visible_before := ('00000000-0000-0000-0000-0000000000f9'
    in (select lorekit_member_org_ids('00000000-0000-0000-0000-0000000000b2')));
  assert v_visible_before,
    'safe-delete: a member must see a live org in lorekit_member_org_ids before soft-delete';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_mem_before from memories where org_id = '00000000-0000-0000-0000-0000000000f9';
  reset role;
  assert v_mem_before = 2,
    format('safe-delete: a member must read both org memories before soft-delete, saw %s', v_mem_before);

  -- Owner A soft-deletes the org.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform lorekit_org_delete('00000000-0000-0000-0000-0000000000f9');
  reset role;

  -- The row still exists (recoverable) but is stamped deleted_at.
  select deleted_at into v_deleted_at from orgs where id = '00000000-0000-0000-0000-0000000000f9';
  assert v_deleted_at is not null,
    'safe-delete: lorekit_org_delete must stamp orgs.deleted_at, not remove the row';

  -- After: member B no longer sees the org in their membership set...
  v_visible_after := ('00000000-0000-0000-0000-0000000000f9'
    in (select lorekit_member_org_ids('00000000-0000-0000-0000-0000000000b2')));
  assert not v_visible_after,
    'safe-delete: a soft-deleted org must disappear from lorekit_member_org_ids';

  -- ...and can no longer read its memories (hidden transitively via the
  -- memories RLS read policy, which routes through lorekit_member_org_ids).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_mem_after from memories where org_id = '00000000-0000-0000-0000-0000000000f9';
  reset role;
  assert v_mem_after = 0,
    format('safe-delete: a soft-deleted org''s memories must be hidden from members, saw %s', v_mem_after);
end;
$$;

-- ── 32. A non-owner can neither soft-delete nor purge ───────────────────────
do $$
declare
  v_delete_denied boolean := false;
  v_purge_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  begin
    perform lorekit_org_delete('00000000-0000-0000-0000-0000000000f9');
  exception when sqlstate 'LK002' then v_delete_denied := true; end;
  begin
    perform lorekit_org_purge('00000000-0000-0000-0000-0000000000f9');
  exception when sqlstate 'LK002' then v_purge_denied := true; end;
  reset role;

  assert v_delete_denied,
    'safe-delete: a member (non-owner) must be denied lorekit_org_delete with LK002';
  assert v_purge_denied,
    'safe-delete: a member (non-owner) must be denied lorekit_org_purge with LK002';
end;
$$;

-- ── 33. Purge cascades the org, its memberships, and its memories away ──────
do $$
declare
  v_orgs int;
  v_members int;
  v_mems int;
begin
  -- Owner A purges (the real, irreversible delete). Works on the already
  -- soft-deleted org from §31.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform lorekit_org_purge('00000000-0000-0000-0000-0000000000f9');
  reset role;

  select count(*) into v_orgs from orgs where id = '00000000-0000-0000-0000-0000000000f9';
  select count(*) into v_members from org_members where org_id = '00000000-0000-0000-0000-0000000000f9';
  select count(*) into v_mems from memories where org_id = '00000000-0000-0000-0000-0000000000f9';

  assert v_orgs = 0, 'safe-delete: purge must remove the orgs row';
  assert v_members = 0, 'safe-delete: purge must cascade org_members away';
  assert v_mems = 0,
    'safe-delete: purge must cascade org-owned memories away (memories.org_id ON DELETE CASCADE)';
end;
$$;

-- ── 33b. Purge works directly on a LIVE org (skipping soft-delete) ──────────
-- The owner may permanently delete without first soft-deleting; purge is not
-- gated on deleted_at.
do $$
declare v_orgs int;
begin
  insert into orgs (id, slug, name, created_by) values
    ('00000000-0000-0000-0000-0000000000fa', 'sod-live', 'Live Purge Org', '00000000-0000-0000-0000-0000000000a1');
  insert into org_members (org_id, user_id, role) values
    ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000a1', 'owner');

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform lorekit_org_purge('00000000-0000-0000-0000-0000000000fa');
  reset role;

  select count(*) into v_orgs from orgs where id = '00000000-0000-0000-0000-0000000000fa';
  assert v_orgs = 0, 'safe-delete: purge must remove a live (never soft-deleted) org too';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Scope → org binding (00026)
-- ═════════════════════════════════════════════════════════════════════════

-- Fresh 'sb-org' (fb) with owner A + member B; C is a non-member.
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000fb', 'sb-org', 'Scope Bind Org', '00000000-0000-0000-0000-0000000000a1');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000fb', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000fb', '00000000-0000-0000-0000-0000000000b2', 'member');

-- ── 34. Bind is admin/owner-only (manage_scopes) ────────────────────────────
do $$
declare
  v_bind_id uuid;
  v_denied boolean;
begin
  -- A non-member (D) is denied.
  v_denied := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  begin
    perform lorekit_scope_bind('00000000-0000-0000-0000-0000000000fb', 'repo::acme/sb');
  exception when sqlstate 'LK002' then v_denied := true; end;
  reset role;
  assert v_denied, 'scope-bind: a non-member must be denied lorekit_scope_bind (LK002)';

  -- A plain member (B) is also denied — manage_scopes needs admin/owner.
  v_denied := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  begin
    perform lorekit_scope_bind('00000000-0000-0000-0000-0000000000fb', 'repo::acme/sb');
  exception when sqlstate 'LK002' then v_denied := true; end;
  reset role;
  assert v_denied, 'scope-bind: a member (non-admin) must be denied lorekit_scope_bind';

  -- The owner (A) binds successfully.
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_scope_bind('00000000-0000-0000-0000-0000000000fb', 'repo::acme/sb') into v_bind_id;
  reset role;
  assert v_bind_id is not null, 'scope-bind: the owner must bind successfully';
  assert (select org_id from org_scope_bindings where scope = 'repo::acme/sb')
         = '00000000-0000-0000-0000-0000000000fb',
    'scope-bind: the binding row must point at the org';
end;
$$;

-- ── 35. Bound-scope write: member routes to org, non-member falls back ───────
do $$
declare
  v_org_routed boolean;
  v_slug text;
  v_row memories%rowtype;
  v_id uuid;
begin
  -- Member B, no explicit org → routed to the bound org, author recorded.
  select id, org_routed, binding_org_slug into v_id, v_org_routed, v_slug
    from memory_write('00000000-0000-0000-0000-0000000000b2', 'repo::acme/sb', 'sb-key', 'v1');
  assert v_org_routed,
    'scope-bind: a write-capable member''s write under a bound scope must route to the org';
  assert v_slug = 'sb-org', format('scope-bind: binding_org_slug should be sb-org, saw %s', v_slug);
  select * into v_row from memories where id = v_id;
  assert v_row.org_id = '00000000-0000-0000-0000-0000000000fb' and v_row.user_id is null,
    'scope-bind: the routed row must be org-owned (org_id set, user_id null)';
  assert v_row.created_by = '00000000-0000-0000-0000-0000000000b2',
    'scope-bind: created_by must record the writer';

  -- Non-member D → personal fallback, but the bound slug is reported (notice).
  select id, org_routed, binding_org_slug into v_id, v_org_routed, v_slug
    from memory_write('00000000-0000-0000-0000-0000000000d4', 'repo::acme/sb', 'sb-key-d', 'v1');
  assert not v_org_routed,
    'scope-bind: a non-member''s write under a bound scope must fall back to personal';
  assert v_slug = 'sb-org',
    'scope-bind: the fallback must still report the bound org slug for the notice';
  select * into v_row from memories where id = v_id;
  assert v_row.org_id is null and v_row.user_id = '00000000-0000-0000-0000-0000000000d4',
    'scope-bind: the fallback row must be personal (user_id set, org_id null)';
end;
$$;

-- ── 36. Explicit org slug bypasses the binding; unbind stops routing ─────────
do $$
declare
  v_org_routed boolean;
  v_slug text;
begin
  -- An explicit p_org_slug takes the explicit branch (binding lookup skipped),
  -- so binding_org_slug is null even though the scope is bound.
  select org_routed, binding_org_slug into v_org_routed, v_slug
    from memory_write('00000000-0000-0000-0000-0000000000b2', 'repo::acme/sb', 'sb-key-explicit', 'v',
                      '{}'::text[], null, null, null, 'sb-org');
  assert v_org_routed and v_slug is null,
    'scope-bind: an explicit org slug must route to the org and bypass the binding lookup';

  -- After unbind, a member''s write under the (now unbound) scope is personal.
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform lorekit_scope_unbind('00000000-0000-0000-0000-0000000000fb', 'repo::acme/sb');
  reset role;

  select org_routed, binding_org_slug into v_org_routed, v_slug
    from memory_write('00000000-0000-0000-0000-0000000000b2', 'repo::acme/sb', 'sb-key-unbound', 'v');
  assert (not v_org_routed) and v_slug is null,
    'scope-bind: after unbind, a write under the scope is personal with no binding slug';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Audit log CHECK widening for scope actions (00027)
-- ═════════════════════════════════════════════════════════════════════════

-- ── 37. scope.bind and scope.unbind are accepted by audit_log.action CHECK ───
do $$
declare
  v_blocked boolean;
begin
  -- scope.bind is now a valid action — the INSERT must succeed.
  insert into audit_log (user_id, action, resource_type, resource_id, target)
  values (
    '00000000-0000-0000-0000-0000000000a1',
    'scope.bind', 'org_scope_binding', gen_random_uuid(), 'scope-check-org'
  );

  -- scope.unbind is now a valid action — the INSERT must succeed.
  insert into audit_log (user_id, action, resource_type, resource_id, target)
  values (
    '00000000-0000-0000-0000-0000000000a1',
    'scope.unbind', 'org_scope_binding', gen_random_uuid(), 'scope-check-org'
  );

  -- An unknown action is still rejected.
  v_blocked := false;
  begin
    insert into audit_log (user_id, action, resource_type, resource_id, target)
    values (
      '00000000-0000-0000-0000-0000000000a1',
      'scope.unknown', 'org_scope_binding', gen_random_uuid(), 'scope-check-org'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  assert v_blocked, 'audit_log: unknown scope action must be rejected by the CHECK constraint';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- GitHub App installations (00037)
-- Tests: idempotent double-apply, pending→linked, RLS isolation,
--        coverage lookup, webhook_secrets untouched by reconcile.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 38. Idempotent double-apply: same installation_id → exactly 1 row (AC-7) ──
do $$
declare
  v_count int;
  v_id1 uuid;
  v_id2 uuid;
begin
  -- First upsert: pending (no matching user).
  select lorekit_installation_upsert(
    9000001, 555001, 'octocat-test', 'User',
    null, 'pending', '{}'::text[]
  ) into v_id1;

  -- Second upsert: same installation_id — must update, not insert a new row.
  select lorekit_installation_upsert(
    9000001, 555001, 'octocat-test', 'User',
    null, 'pending', '{}'::text[]
  ) into v_id2;

  select count(*) into v_count
    from github_installations where installation_id = 9000001;

  assert v_count = 1,
    format('installation idempotency: double-apply must produce exactly 1 row, got %s', v_count);
  assert v_id1 = v_id2,
    'installation idempotency: both upserts must return the same row id';
end;
$$;

-- ── 39. pending → linked transition on user match (AC-4, AC-5) ───────────────
do $$
declare
  v_status text;
  v_user_id uuid;
begin
  -- Seed a pending installation.
  perform lorekit_installation_upsert(
    9000002, 555002, 'pending-user', 'User',
    null, 'pending', '{}'::text[]
  );

  -- Verify it is pending with user_id NULL.
  select status, user_id into v_status, v_user_id
    from github_installations where installation_id = 9000002;
  assert v_status = 'pending',
    format('pending install: expected status=pending, got %s', v_status);
  assert v_user_id is null,
    'pending install: user_id must be NULL for a pending installation';

  -- Transition to linked by re-upserting with a matched user_id.
  perform lorekit_installation_upsert(
    9000002, 555002, 'pending-user', 'User',
    '00000000-0000-0000-0000-0000000000a1', 'linked', '{}'::text[]
  );

  -- Verify it is now linked.
  select status, user_id into v_status, v_user_id
    from github_installations where installation_id = 9000002;
  assert v_status = 'linked',
    format('linked transition: expected status=linked, got %s', v_status);
  assert v_user_id = '00000000-0000-0000-0000-0000000000a1',
    format('linked transition: user_id must be the matched user, got %s', v_user_id);
end;
$$;

-- ── 40. Linked status never regresses to pending on re-delivery (AC-7) ────────
do $$
declare v_status text;
begin
  -- A subsequent delivery of the same event as pending must not overwrite the linked status.
  perform lorekit_installation_upsert(
    9000002, 555002, 'pending-user', 'User',
    null, 'pending', '{}'::text[]
  );

  select status into v_status
    from github_installations where installation_id = 9000002;

  assert v_status = 'linked',
    format('no regression: a linked installation must not regress to pending on re-delivery, got %s', v_status);
end;
$$;

-- ── 41. Installation repositories: add, active rows tracked (AC-2) ─────
do $$
declare
  v_count int;
begin
  -- Upsert installation 9000003 with two covered repos.
  perform lorekit_installation_upsert(
    9000003, 555003, 'app-org', 'Organization',
    null, 'pending',
    array['acme/covered-repo', 'acme/another-repo']
  );

  -- Two covered repos were inserted; both must be active.
  select count(*) into v_count
    from installation_repositories where installation_id = 9000003 and active = true;
  assert v_count = 2,
    format('installation repos: expected 2 active rows for installation 9000003, got %s', v_count);

  assert exists (select 1 from installation_repositories where installation_id = 9000003 and full_name = 'acme/covered-repo' and active = true),
    'installation repos: acme/covered-repo must be present and active';
  assert exists (select 1 from installation_repositories where installation_id = 9000003 and full_name = 'acme/another-repo' and active = true),
    'installation repos: acme/another-repo must be present and active';
end;
$$;

-- ── 42. Remove repos: inactive flag set correctly (AC-2) ───────────────
do $$
begin
  -- Remove one of the two repos added in §41.
  perform lorekit_installation_remove_repos(9000003, array['acme/covered-repo']);

  -- The removed repo must be inactive.
  assert exists (select 1 from installation_repositories where installation_id = 9000003 and full_name = 'acme/covered-repo' and active = false),
    'remove repos: acme/covered-repo must be inactive after removal';

  -- The other repo must still be active.
  assert exists (select 1 from installation_repositories where installation_id = 9000003 and full_name = 'acme/another-repo' and active = true),
    'remove repos: acme/another-repo must still be active after partial removal';
end;
$$;

-- ── 43. Remove installation: all repos go inactive, status=removed (AC-2) ─────
do $$
declare
  v_status text;
begin
  perform lorekit_installation_remove(9000003);

  select status into v_status
    from github_installations where installation_id = 9000003;
  assert v_status = 'removed',
    format('remove installation: status must be removed, got %s', v_status);

  -- All repos for this installation must be inactive after removal.
  assert not exists (select 1 from installation_repositories where installation_id = 9000003 and active = true),
    'remove installation: all repos must be inactive after installation removal';
end;
$$;

-- ── 44. RLS: user A sees only their own linked installations (AC-10) ──────────
do $$
declare
  v_visible_a int;
  v_visible_b int;
begin
  -- Link installation 9000002 to user A (already linked above).
  -- Insert a second installation linked to a different user (B, 0000b2).
  perform lorekit_installation_upsert(
    9000004, 555004, 'user-b-gh', 'User',
    '00000000-0000-0000-0000-0000000000b2', 'linked', '{}'::text[]
  );

  -- User A should see only their own linked installation (9000002).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select count(*) into v_visible_a from github_installations;
  reset role;

  -- User B should see only their own linked installation (9000004).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_visible_b from github_installations;
  reset role;

  assert v_visible_a = 1,
    format('installations RLS: user A must see only their own linked installation, saw %s', v_visible_a);
  assert v_visible_b = 1,
    format('installations RLS: user B must see only their own linked installation, saw %s', v_visible_b);
end;
$$;

-- ── 45. Pending rows are invisible to authenticated users (AC-4) ─────────────
do $$
declare v_visible int;
begin
  -- installation 9000001 is pending (user_id NULL) — neither A nor B owns it.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- This query would see 9000001 if RLS were broken.
  select count(*) into v_visible
    from github_installations where installation_id = 9000001;
  reset role;

  assert v_visible = 0,
    format('pending RLS: a pending installation (user_id NULL) must be invisible to authenticated users, saw %s', v_visible);
end;
$$;

-- ── 46. webhook_secrets row count must be unchanged by reconcile (AC-2) ───────
-- This asserts that the App reconcile path (lorekit_installation_upsert) does
-- NOT write any webhook_secrets rows.  Count before and after a reconcile cycle.
do $$
declare
  v_count_before int;
  v_count_after int;
begin
  select count(*) into v_count_before from webhook_secrets;

  -- Full reconcile cycle: create, add repos, remove repos, remove installation.
  perform lorekit_installation_upsert(
    9000099, 555099, 'no-secret-write', 'User',
    null, 'pending', array['nope/repo1']
  );
  perform lorekit_installation_remove_repos(9000099, array['nope/repo1']);
  perform lorekit_installation_remove(9000099);

  select count(*) into v_count_after from webhook_secrets;

  assert v_count_after = v_count_before,
    format('webhook_secrets isolation: reconcile must not write any webhook_secrets rows (before=%s after=%s)',
           v_count_before, v_count_after);
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Invite-details modal: lorekit_invite_org_details (00028)
-- ═════════════════════════════════════════════════════════════════════════

-- ── 47. lorekit_invite_org_details: the addressed invitee gets exactly one
-- row of Tier-A org details; a different authenticated user gets zero (AC-2) ─
do $$
declare
  v_invite_id       uuid;
  v_row             record;
  v_row_count       int;
  v_expected_org_name text;
  v_expected_org_slug text;
  v_expected_members  int;
  v_expected_handle   text;
  v_expected_avatar   text;
begin
  -- Owner (A) invites H by email to org f3 — a fresh pending invite (H's
  -- earlier invites in §24 are declined/revoked, so no partial-unique
  -- collision).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select lorekit_org_invite('00000000-0000-0000-0000-0000000000f3', 'lk-mig-h@test.local', null, 'member')
    into v_invite_id;
  reset role;

  -- Read the org's CURRENT name/slug/member-count dynamically rather than
  -- the values it was seeded with — earlier sections rename it (§ before 23)
  -- and change its membership (§25/§29-ish leave/remove), so a hardcoded
  -- literal would silently couple this assertion to test ordering.
  select name, slug into v_expected_org_name, v_expected_org_slug
    from orgs where id = '00000000-0000-0000-0000-0000000000f3';
  select count(*) into v_expected_members
    from org_members where org_id = '00000000-0000-0000-0000-0000000000f3';

  -- A different authenticated user (C, a co-member of the SAME org — see
  -- §21's role-change, still 'member' — but NOT the addressed invitee) must
  -- get zero rows — the gate is identity-bound, not membership-bound, so
  -- co-membership alone is no free pass.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"lk-mig-c@test.local"}', true);
  select count(*) into v_row_count from lorekit_invite_org_details(v_invite_id);
  reset role;
  assert v_row_count = 0,
    format('lorekit_invite_org_details: a non-addressed authenticated user must get zero rows, got %s', v_row_count);

  -- The addressed invitee (H, matched on verified JWT email) gets exactly
  -- one row of Tier-A org details.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated","email":"lk-mig-h@test.local"}', true);
  select * into v_row from lorekit_invite_org_details(v_invite_id);
  reset role;

  assert v_row.org_name = v_expected_org_name,
    format('lorekit_invite_org_details: expected org_name %s, got %s', v_expected_org_name, v_row.org_name);
  assert v_row.org_slug = v_expected_org_slug,
    format('lorekit_invite_org_details: expected org_slug %s, got %s', v_expected_org_slug, v_row.org_slug);
  assert v_row.member_count = v_expected_members,
    format('lorekit_invite_org_details: expected member_count %s, got %s', v_expected_members, v_row.member_count);
  -- The inviter (owner A) is seeded with raw_user_meta_data (§ before 24), so
  -- the function resolves A's real handle/avatar from auth.users. Read the
  -- expected values dynamically rather than hardcoding — same rationale as the
  -- org_name/slug reads above — which also exercises the positive
  -- inviter-identity resolution path (the coalesce over user_name/avatar_url).
  select raw_user_meta_data ->> 'user_name', raw_user_meta_data ->> 'avatar_url'
    into v_expected_handle, v_expected_avatar
    from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
  assert v_row.inviter_handle = v_expected_handle,
    format('lorekit_invite_org_details: expected inviter_handle %s, got %s', v_expected_handle, v_row.inviter_handle);
  assert v_row.inviter_avatar_url = v_expected_avatar,
    format('lorekit_invite_org_details: expected inviter_avatar_url %s, got %s', v_expected_avatar, v_row.inviter_avatar_url);
end;
$$;


-- ── Memory TTL — 00030 + 00031 + 00038 ──────────────────────────────────────
-- Migration 00038 replaced p_ttl_days with p_ttl_seconds in memory_write.
-- All positional TTL arguments below are in SECONDS. Conversions:
--   7 days  = 604800 s    30 days = 2592000 s    1 day = 86400 s
-- AC-1: Writing with p_ttl_seconds sets expires_at approximately that many seconds from now.
-- AC-2: An expired memory is invisible to a plain SELECT (query-layer filter).
-- AC-3: A non-expired memory with a TTL is still visible.
-- AC-4: Updating without p_ttl_seconds leaves existing expires_at unchanged.
-- AC-5: Updating with a new p_ttl_seconds refreshes expires_at.
-- AC-6: purge_expired_memories deletes expired rows and returns the count.
-- AC-7: purge_expired_memories does NOT delete non-expired TTL rows.
-- AC-8: Rows without a TTL (expires_at IS NULL) are unaffected by purge_expired_memories.
-- AC-9: p_ttl_seconds < 1 raises a P0001 exception.

do $$
declare
  v_id         uuid;
  v_expires_at timestamptz;
  v_count      int;
  v_uid        uuid := '00000000-0000-0000-0000-0000000000a1';
  v_purged     int;
  v_blocked    boolean;
  v_prev_claims text;
begin
  -- AC-1: Write a memory with p_ttl_seconds=604800 (7 days); expires_at must be ~7 days ahead.
  select id, expires_at into v_id, v_expires_at
  from memory_write(v_uid, 'global', 'ttl-test-7d', 'transient value', '{}', null, null, null, null, 604800);

  assert v_expires_at is not null,
    'TTL AC-1: expires_at must be set when p_ttl_seconds is provided';
  assert v_expires_at > now() + interval '604799 seconds',
    'TTL AC-1: expires_at must be at least 7 days from now';
  assert v_expires_at < now() + interval '604800 seconds' + interval '1 hour',
    'TTL AC-1: expires_at must not exceed 7 days + 1h from now';

  -- AC-2: Manually set expires_at to the past; the row is invisible to active reads.
  update memories set expires_at = now() - interval '1 second'
   where id = v_id;

  select count(*) into v_count
   from memories
   where user_id = v_uid and key = 'ttl-test-7d'
     and archived_at is null
     and (expires_at is null or expires_at > now());
  assert v_count = 0,
    'TTL AC-2: an expired memory must be invisible to the active-read filter';

  -- AC-3: Write a memory with p_ttl_seconds=86400 (1 day, future); it must be visible.
  perform memory_write(v_uid, 'global', 'ttl-test-future', 'future value', '{}', null, null, null, null, 86400);
  select count(*) into v_count
   from memories
   where user_id = v_uid and key = 'ttl-test-future'
     and archived_at is null
     and (expires_at is null or expires_at > now());
  assert v_count = 1,
    'TTL AC-3: a non-expired TTL memory must be visible';

  -- AC-4: Update without p_ttl_seconds; expires_at must stay unchanged.
  select expires_at into v_expires_at
   from memories where user_id = v_uid and key = 'ttl-test-future';
  perform memory_write(v_uid, 'global', 'ttl-test-future', 'updated value', '{}', null, null, null, null, null);
  select count(*) into v_count
   from memories
   where user_id = v_uid and key = 'ttl-test-future'
     and expires_at = v_expires_at;
  assert v_count = 1,
    'TTL AC-4: omitting p_ttl_seconds on an update must preserve the existing expires_at';

  -- AC-5: Update WITH a new p_ttl_seconds=2592000 (30 days); expires_at must be refreshed.
  perform memory_write(v_uid, 'global', 'ttl-test-future', 'refreshed value', '{}', null, null, null, null, 2592000);
  select count(*) into v_count
   from memories
   where user_id = v_uid and key = 'ttl-test-future'
     and expires_at > now() + interval '2591999 seconds';
  assert v_count = 1,
    'TTL AC-5: supplying a new p_ttl_seconds on an update must refresh expires_at';

  -- AC-6: purge_expired_memories deletes past-expired rows and returns the count.
  -- Insert a row with a past expiry directly (bypassing memory_write validation).
  insert into memories (user_id, scope, key, value, expires_at)
  values (v_uid, 'global', 'ttl-expired-purge', 'gone', now() - interval '1 minute');

  -- 00046 resolves the effective actor from auth.uid() (a caller-supplied p_user_id
  -- is honoured only on a service-role connection), so the purge must run under the
  -- OWNING user's authenticated session — the same self-service idiom as §60b.
  -- The claims in force here are whatever an earlier section left behind, so save
  -- and restore them to keep this block hermetic.
  v_prev_claims := current_setting('request.jwt.claims', true);
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select purge_expired_memories(v_uid) into v_purged;

  reset role;
  assert v_purged >= 1,
    format('TTL AC-6: purge_expired_memories must delete >= 1 expired row, got %s', v_purged);
  select count(*) into v_count
   from memories where user_id = v_uid and key = 'ttl-expired-purge';
  assert v_count = 0,
    'TTL AC-6: the expired row must be physically deleted after purge';

  -- AC-7: purge_expired_memories does NOT delete a future-expiry row.
  select count(*) into v_count
   from memories where user_id = v_uid and key = 'ttl-test-future';
  assert v_count = 1,
    'TTL AC-7: purge_expired_memories must not delete a memory with a future expires_at';

  -- AC-8: Rows with expires_at IS NULL are unaffected by purge_expired_memories.
  insert into memories (user_id, scope, key, value)
  values (v_uid, 'global', 'ttl-no-expiry', 'permanent');

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select purge_expired_memories(v_uid) into v_purged;

  reset role;
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);

  select count(*) into v_count
   from memories where user_id = v_uid and key = 'ttl-no-expiry';
  assert v_count = 1,
    'TTL AC-8: purge_expired_memories must not delete rows with no expires_at';

  -- AC-9: p_ttl_seconds < 1 must raise a P0001 exception.
  v_blocked := false;
  begin
    perform memory_write(v_uid, 'global', 'ttl-bad', 'bad', '{}', null, null, null, null, 0);
  exception when sqlstate 'P0001' then
    v_blocked := true;
  end;
  assert v_blocked, 'TTL AC-9: p_ttl_seconds = 0 must raise SQLSTATE P0001';

  -- AC-10: p_ttl_seconds > 31536000 also raises a P0001 exception (upper-bound guard).
  v_blocked := false;
  begin
    perform memory_write(v_uid, 'global', 'ttl-upper-bound', 'bad', '{}', null, null, null, null, 31536001, false);
  exception when sqlstate 'P0001' then
    v_blocked := true;
  end;
  assert v_blocked, 'TTL AC-10: p_ttl_seconds = 31536001 must raise SQLSTATE P0001';
end;
$$;


-- ── Memory TTL clear — 00031 + 00038 ────────────────────────────────────────
-- Migration 00038 replaced p_ttl_days with p_ttl_seconds in memory_write.
-- All positional TTL arguments below are in SECONDS:
--   7 days = 604800 s    30 days = 2592000 s    14 days = 1209600 s
-- AC-1: p_clear_ttl = true clears an existing expires_at (sets it to NULL).
-- AC-2: p_clear_ttl wins over p_ttl_seconds when both are supplied.
-- AC-3: p_clear_ttl = false with no p_ttl_seconds leaves expires_at unchanged.

do $$
declare
  v_uid     uuid := '00000000-0000-0000-0000-0000000000a1';
  v_exp     timestamptz;
  v_count   int;
begin
  -- Seed: write with a 7-day TTL (604800 seconds).
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'v', '{}', null, null, null, null, 604800, false);
  select expires_at into v_exp from memories where user_id = v_uid and key = 'ttl-clear-test';
  assert v_exp is not null, 'TTL-clear AC-0: seed must have expires_at set';

  -- AC-1: clear removes it.
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'v2', '{}', null, null, null, null, null, true);
  select expires_at into v_exp from memories where user_id = v_uid and key = 'ttl-clear-test';
  assert v_exp is null, 'TTL-clear AC-1: p_clear_ttl = true must set expires_at = NULL';

  -- AC-2: clear wins when p_ttl_seconds is also supplied (30 days = 2592000 s, 14 days = 1209600 s).
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'v3', '{}', null, null, null, null, 2592000, false);
  select expires_at into v_exp from memories where user_id = v_uid and key = 'ttl-clear-test';
  assert v_exp is not null, 'TTL-clear AC-2a: seed 30-day TTL';
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'v4', '{}', null, null, null, null, 1209600, true);
  select expires_at into v_exp from memories where user_id = v_uid and key = 'ttl-clear-test';
  assert v_exp is null, 'TTL-clear AC-2: p_clear_ttl wins over p_ttl_seconds';

  -- AC-3: neither flag leaves expires_at unchanged.
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'v5', '{}', null, null, null, null, 604800, false);
  select expires_at into v_exp from memories where user_id = v_uid and key = 'ttl-clear-test';
  assert v_exp is not null, 'TTL-clear AC-3a: seed';
  perform memory_write(v_uid, 'global', 'ttl-clear-test', 'updated value', '{}', null, null, null, null, null, false);
  select count(*) into v_count from memories
   where user_id = v_uid and key = 'ttl-clear-test' and expires_at is not null;
  assert v_count = 1, 'TTL-clear AC-3: no-flag update must preserve existing expires_at';
end;
$$;


-- ── Memory scopes — 00039 ───────────────────────────────────────────────────
-- lorekit_memory_scopes(p_user_id) backs GET /memories/scopes. It aggregates in
-- Postgres precisely so the count is exact past PostgREST's row cap, which means
-- these assertions are the only place the visibility predicate and the
-- active-row definition are actually executed.
-- AC-1: A caller sees their OWN scopes, with an exact active count.
-- AC-2: A caller does NOT see another user's scopes.
-- AC-3: Archived rows are excluded from the count.
-- AC-4: Expired rows are excluded from the count.
-- AC-5: A scope whose every row is archived disappears from the result entirely.
-- AC-6: An org co-member sees the org's scopes (via lorekit_member_org_ids).
-- AC-7: A non-member does not see that org's scopes.
-- AC-8: Rows come back sorted by count DESC, then scope asc (00065, matching
--       lorekit_memory_tags) — the busiest scope leads regardless of name.

-- Fresh 'scopes-org' (fa) with owner A + member B, isolated from the phase-3
-- and safe-org-deletion fixtures above (f3 has unrelated membership churn, f9
-- is soft-deleted) so these counts can't be perturbed by an earlier section.
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000fa', 'scopes-org', 'Scopes Org', '00000000-0000-0000-0000-0000000000a1');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000b2', 'member');

-- User A: two active rows, one archived and one already-expired row in the SAME
-- scope (so the count, not the scope's presence, proves the exclusion), plus a
-- scope that is archived-only.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::scopes-a', 'sc-a-1', 'v'),
  ('00000000-0000-0000-0000-0000000000a1', 'project::scopes-a', 'sc-a-2', 'v');
insert into memories (user_id, scope, key, value, archived_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::scopes-a', 'sc-a-archived', 'v', now()),
  ('00000000-0000-0000-0000-0000000000a1', 'project::scopes-gone', 'sc-gone', 'v', now());
insert into memories (user_id, scope, key, value, expires_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::scopes-a', 'sc-a-expired', 'v', now() - interval '1 minute');

-- A busier scope for A (3 active rows) whose name sorts AFTER project::scopes-a.
-- Under the old `scope asc` order it would come last; under 00065's `count desc`
-- it must come FIRST — so A's result distinguishes the two orderings (AC-8).
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000a1', 'repo::acme/scopes-top', 'sc-top-1', 'v'),
  ('00000000-0000-0000-0000-0000000000a1', 'repo::acme/scopes-top', 'sc-top-2', 'v'),
  ('00000000-0000-0000-0000-0000000000a1', 'repo::acme/scopes-top', 'sc-top-3', 'v');

-- User B: one active row in a scope of their own.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::scopes-b', 'sc-b-1', 'v');

-- Org-owned row (user_id NULL, org_id set) — visible to BOTH members of fa.
insert into memories (user_id, org_id, scope, key, value) values
  (null, '00000000-0000-0000-0000-0000000000fa', 'repo::acme/scopes-org', 'sc-org-1', 'v');

do $$
declare
  v_count        bigint;
  v_rows         int;
  v_scopes       text[];
  v_sorted       text[];
begin
  -- 00047 gave lorekit_memory_scopes the service-role-gated actor guard: a
  -- caller-supplied p_user_id is honoured only on a verified service-role
  -- connection, otherwise auth.uid() wins. Adopt that context — it is exactly
  -- how the edge GET /memories/scopes path invokes it (a service-role client
  -- naming the token owner). Without it the actor resolves to a NULL auth.uid()
  -- and every assertion below reads an empty result set.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1 + AC-3 + AC-4: A's own scope is present, counting ONLY the two active
  -- rows — the archived and the expired sibling in the same scope are excluded.
  select count into v_count
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::scopes-a';
  assert v_count = 2,
    format('memory scopes AC-1/3/4: project::scopes-a must count 2 active rows (archived + expired excluded), got %s', v_count);

  -- AC-5: the archived-only scope is absent altogether, not present with count 0.
  select count(*) into v_rows
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::scopes-gone';
  assert v_rows = 0,
    'memory scopes AC-5: a scope whose every row is archived must not appear at all';

  -- AC-2: A must not see B's personal scope.
  select count(*) into v_rows
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::scopes-b';
  assert v_rows = 0,
    'memory scopes AC-2: a caller must never see another user''s scopes';

  -- AC-6: co-member B sees the ORG's scope even though the row is not theirs
  -- (user_id IS NULL) — the lorekit_member_org_ids branch of the predicate.
  select count into v_count
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000b2')
   where scope = 'repo::acme/scopes-org';
  assert v_count = 1,
    format('memory scopes AC-6: an org co-member must see the org scope with count 1, got %s', v_count);

  -- ...and still sees their own personal scope alongside it.
  select count into v_count
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000b2')
   where scope = 'project::scopes-b';
  assert v_count = 1,
    format('memory scopes AC-6b: B must also see their own scope, got %s', v_count);

  -- AC-7: user C is in no org and owns none of these rows — sees none of them.
  select count(*) into v_rows
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000c3')
   where scope in ('project::scopes-a', 'project::scopes-b', 'repo::acme/scopes-org');
  assert v_rows = 0,
    'memory scopes AC-7: a non-member/non-owner must see none of these scopes';

  -- AC-8: the function returns rows already ordered by count desc, then scope
  -- asc. `array_agg` with no ORDER BY preserves the function-scan row order, so
  -- comparing it against the same rows re-sorted by the intended key asserts the
  -- function itself did the ordering.
  select array_agg(scope) into v_scopes
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1');
  select array_agg(scope order by count desc, scope asc) into v_sorted
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1');
  assert v_scopes = v_sorted,
    format('memory scopes AC-8: results must be ordered by count desc then scope asc, got %s', v_scopes);
  -- Concretely, over the three scopes A owns with known counts: they must appear
  -- busiest-first — top(3) before scopes-a(2) before scopes-org(1) — regardless
  -- of the other scopes A carries from earlier fixtures. Under the old `scope
  -- asc` this order was top LAST, so this only holds once count drives it.
  assert array_position(v_scopes, 'repo::acme/scopes-top')
           < array_position(v_scopes, 'project::scopes-a')
     and array_position(v_scopes, 'project::scopes-a')
           < array_position(v_scopes, 'repo::acme/scopes-org'),
    format('memory scopes AC-8: known scopes must be count-desc top(3)<scopes-a(2)<scopes-org(1), got %s', v_scopes);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;


-- ═════════════════════════════════════════════════════════════════════════
-- Audit log CHECK widening for the GitHub App action (00040)
-- ═════════════════════════════════════════════════════════════════════════

-- ── 48. github_app.installation_linked is accepted by audit_log.action CHECK ──
-- This is a regression test for a SILENT failure, which is why it belongs at the
-- SQL level and nowhere else. packages/web/src/lib/github-installations.ts's
-- handleSetupReturn has been auditing 'github_app.installation_linked' since the
-- GitHub App work landed, but the 00027 CHECK did not admit it: Postgres
-- rejected the INSERT and recordAuditEvent — deliberately non-throwing, so an
-- audit failure can never break the operation it audits — swallowed the error.
-- Nothing in the app layer could observe the loss. Only an assertion against the
-- real constraint can.
--
-- The negative half matters just as much: a widened CHECK that admitted anything
-- would "fix" the bug by removing the guarantee, so a genuinely bogus action
-- must still be rejected.
do $$
declare
  v_blocked boolean;
begin
  -- The action the CHECK used to reject — the INSERT must now succeed.
  insert into audit_log (user_id, action, resource_type, resource_id, target)
  values (
    '00000000-0000-0000-0000-0000000000a1',
    'github_app.installation_linked', 'github_installation', gen_random_uuid(), '12345678'
  );

  -- An unknown action in the same namespace is still rejected: 00040 widened the
  -- CHECK by exactly one value, it did not loosen the prefix.
  v_blocked := false;
  begin
    insert into audit_log (user_id, action, resource_type, resource_id, target)
    values (
      '00000000-0000-0000-0000-0000000000a1',
      'github_app.installation_removed', 'github_installation', gen_random_uuid(), '12345678'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  assert v_blocked,
    'audit_log: an unknown github_app.* action must still be rejected by the CHECK constraint';

  -- ...and so is a plainly bogus one, so the constraint has not degenerated into
  -- accepting free text.
  v_blocked := false;
  begin
    insert into audit_log (user_id, action, resource_type, resource_id, target)
    values (
      '00000000-0000-0000-0000-0000000000a1',
      'definitely.not.an.action', 'github_installation', gen_random_uuid(), '12345678'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  assert v_blocked,
    'audit_log: a bogus action must still be rejected by the CHECK constraint';
end;
$$;

-- ── 49. Every action in the widened CHECK round-trips (00040) ────────────────
-- The CHECK list must match AUDIT_ACTIONS in packages/schemas/src/audit.ts. That
-- correspondence is asserted textually in Node by
-- packages/mcp-core/src/audit-actions-drift.spec.ts; this asserts the SQL half is
-- actually insertable — a value present in the constraint but rejected for some
-- other reason (a column type, a second constraint) would still be audit loss.
do $$
declare
  v_action text;
  v_count  int;
  v_actions text[] := array[
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
  ];
begin
  -- Anti-vacuity: an empty or truncated array would make the loop below assert
  -- nothing at all.
  assert array_length(v_actions, 1) = 24,
    format('audit_log CHECK round-trip: expected 24 actions to test, got %s', array_length(v_actions, 1));

  foreach v_action in array v_actions loop
    insert into audit_log (user_id, action, resource_type, target)
    values ('00000000-0000-0000-0000-0000000000a1', v_action, 'roundtrip', v_action);
  end loop;

  select count(*) into v_count
    from audit_log
   where resource_type = 'roundtrip'
     and user_id = '00000000-0000-0000-0000-0000000000a1';
  assert v_count = 24,
    format('audit_log CHECK round-trip: expected 24 inserted rows, got %s', v_count);
end;
$$;



-- ═════════════════════════════════════════════════════════════════════════
-- Org actor override — 00041_org_actor_override.sql
--
-- 00041 gives eight org RPCs a trailing `p_actor_user_id uuid default null`
-- so the REST `orgs` function can serve `lk_*` API tokens, which reach
-- Postgres over a SERVICE-ROLE connection with no `auth.uid()` of their own.
--
-- The whole safety of that rests on one claim, and this section exists to
-- PROVE it rather than assert it in a comment: an `authenticated` caller's
-- `p_actor_user_id` is ignored completely. Only `auth.role() = 'service_role'`
-- — a claim PostgREST copies out of an already-verified JWT, never out of
-- request input — unlocks naming an actor.
--
-- The sessions below are forged exactly like §7/§8/§19-§28 above: `set local
-- role` plus a `request.jwt.claims` GUC. The service-role sessions set
-- `{"role":"service_role"}` with NO `sub`, which is precisely the shape a
-- service-key connection has — and the reason `auth.uid()` is NULL there.
-- ═════════════════════════════════════════════════════════════════════════

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000ac01', 'authenticated', 'authenticated', 'lk-actor-owner@test.local',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000ac02', 'authenticated', 'authenticated', 'lk-actor-outsider@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000ac03', 'authenticated', 'authenticated', 'lk-actor-member@test.local',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000ac04', 'authenticated', 'authenticated', 'lk-actor-admin@test.local',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000ac05', 'authenticated', 'authenticated', 'lk-actor-target@test.local',  now(), now());

insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-00000000ac10', 'actor-override-org', 'Actor Override Org', '00000000-0000-0000-0000-00000000ac01'),
  ('00000000-0000-0000-0000-00000000ac11', 'actor-override-del', 'Actor Override Delete', '00000000-0000-0000-0000-00000000ac01');

insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000ac10', '00000000-0000-0000-0000-00000000ac01', 'owner'),
  ('00000000-0000-0000-0000-00000000ac10', '00000000-0000-0000-0000-00000000ac04', 'admin'),
  ('00000000-0000-0000-0000-00000000ac10', '00000000-0000-0000-0000-00000000ac03', 'member'),
  ('00000000-0000-0000-0000-00000000ac10', '00000000-0000-0000-0000-00000000ac05', 'member'),
  ('00000000-0000-0000-0000-00000000ac11', '00000000-0000-0000-0000-00000000ac01', 'owner');

-- ── 50. lorekit_org_actor resolves the actor per the documented rule ─────────
-- The resolver in isolation, before any RPC uses it. Four cases, which
-- together are the whole contract:
--   authenticated + override        -> auth.uid()  (the override is ignored)
--   authenticated, no override      -> auth.uid()
--   service_role + override         -> the override
--   service_role, no override, no sub -> NULL      (fails closed downstream)
do $$
declare
  v_actor uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000ac02","role":"authenticated"}', true);

  select lorekit_org_actor('00000000-0000-0000-0000-00000000ac01') into v_actor;
  assert v_actor = '00000000-0000-0000-0000-00000000ac02',
    format('lorekit_org_actor: an authenticated caller must resolve to auth.uid(), never to p_actor_user_id — got %s', v_actor);

  select lorekit_org_actor(null) into v_actor;
  assert v_actor = '00000000-0000-0000-0000-00000000ac02',
    'lorekit_org_actor: an authenticated caller with no override must still resolve to auth.uid()';
  reset role;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select lorekit_org_actor('00000000-0000-0000-0000-00000000ac01') into v_actor;
  assert v_actor = '00000000-0000-0000-0000-00000000ac01',
    format('lorekit_org_actor: service_role must be able to name an actor — got %s', v_actor);

  select lorekit_org_actor(null) into v_actor;
  assert v_actor is null,
    format('lorekit_org_actor: service_role with no override and no sub must resolve to NULL (fail closed) — got %s', v_actor);
  reset role;
end;
$$;

-- ── 51. NEGATIVE: an authenticated caller cannot act as someone else ─────────
-- The security case this whole migration turns on. AC02 is not a member of
-- the org at all; AC01 is its owner. AC02 passes AC01's user id as
-- `p_actor_user_id` on every RPC that accepts one and must be denied every
-- time, with the org left untouched.
--
-- The mirror-image case is asserted too: the OWNER passing an outsider's id
-- must still SUCCEED, because the parameter is ignored in both directions —
-- it is not "whose permissions to use", it is inert for this caller.
do $$
declare
  v_denied_rename        boolean := false;
  v_denied_delete        boolean := false;
  v_denied_invite        boolean := false;
  v_denied_member_role   boolean := false;
  v_denied_member_remove boolean := false;
  v_member_count         int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000ac02","role":"authenticated"}', true);

  begin
    perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Hijacked By Outsider',
                               '00000000-0000-0000-0000-00000000ac01');
  exception when sqlstate 'LK002' then v_denied_rename := true; end;

  begin
    perform lorekit_org_delete('00000000-0000-0000-0000-00000000ac10',
                               '00000000-0000-0000-0000-00000000ac01');
  exception when sqlstate 'LK002' then v_denied_delete := true; end;

  begin
    perform lorekit_org_invite('00000000-0000-0000-0000-00000000ac10', 'hijack@test.local', null, 'member',
                               '00000000-0000-0000-0000-00000000ac01');
  exception when sqlstate 'LK002' then v_denied_invite := true; end;

  begin
    perform lorekit_org_member_role('00000000-0000-0000-0000-00000000ac10',
                                    '00000000-0000-0000-0000-00000000ac05', 'admin',
                                    '00000000-0000-0000-0000-00000000ac01');
  exception when sqlstate 'LK002' then v_denied_member_role := true; end;

  begin
    perform lorekit_org_member_remove('00000000-0000-0000-0000-00000000ac10',
                                      '00000000-0000-0000-0000-00000000ac05',
                                      '00000000-0000-0000-0000-00000000ac01');
  exception when sqlstate 'LK002' then v_denied_member_remove := true; end;

  -- A membership-gated READ must be empty too, not merely "denied".
  select count(*) into v_member_count
    from lorekit_org_members_list('00000000-0000-0000-0000-00000000ac10',
                                  '00000000-0000-0000-0000-00000000ac01');
  reset role;

  assert v_denied_rename,
    'IMPERSONATION: an authenticated non-member passed the owner id as p_actor_user_id and lorekit_org_rename did NOT deny it';
  assert v_denied_delete,
    'IMPERSONATION: lorekit_org_delete honoured an authenticated caller''s p_actor_user_id';
  assert v_denied_invite,
    'IMPERSONATION: lorekit_org_invite honoured an authenticated caller''s p_actor_user_id';
  assert v_denied_member_role,
    'IMPERSONATION: lorekit_org_member_role honoured an authenticated caller''s p_actor_user_id';
  assert v_denied_member_remove,
    'IMPERSONATION: lorekit_org_member_remove honoured an authenticated caller''s p_actor_user_id';
  assert v_member_count = 0,
    format('IMPERSONATION: lorekit_org_members_list leaked %s rows to an authenticated non-member naming the owner as actor', v_member_count);

  assert (select name from orgs where id = '00000000-0000-0000-0000-00000000ac10') = 'Actor Override Org',
    'IMPERSONATION: the org name changed — a denied rename still mutated state';
  assert (select deleted_at from orgs where id = '00000000-0000-0000-0000-00000000ac10') is null,
    'IMPERSONATION: the org was soft-deleted by a denied delete';
  assert not exists (select 1 from org_invites where org_id = '00000000-0000-0000-0000-00000000ac10' and invitee_email = 'hijack@test.local'),
    'IMPERSONATION: a denied invite still inserted a row';
  assert (select role from org_members where org_id = '00000000-0000-0000-0000-00000000ac10' and user_id = '00000000-0000-0000-0000-00000000ac05') = 'member',
    'IMPERSONATION: a denied role change still applied';
end;
$$;

-- ── 52. The override is inert for an authenticated caller in BOTH directions ─
-- The owner naming an outsider as `p_actor_user_id` must still act as the
-- OWNER. If the parameter were honoured for authenticated callers this would
-- fail with LK002 — so this is the positive half of §51's proof, and it also
-- pins the backward-compatibility promise (the same call with the parameter
-- omitted behaves identically).
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000ac01","role":"authenticated"}', true);

  perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Renamed Ignoring Override',
                             '00000000-0000-0000-0000-00000000ac02');
  reset role;
  assert (select name from orgs where id = '00000000-0000-0000-0000-00000000ac10') = 'Renamed Ignoring Override',
    'lorekit_org_rename: the owner''s own rename must succeed even when p_actor_user_id names an outsider (the parameter is inert)';

  -- Backward compatibility: the pre-00041 two-argument call still resolves.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000ac01","role":"authenticated"}', true);
  perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Renamed Without Override');
  reset role;
  assert (select name from orgs where id = '00000000-0000-0000-0000-00000000ac10') = 'Renamed Without Override',
    'lorekit_org_rename: omitting p_actor_user_id must keep working (the web server actions never pass it)';
end;
$$;

-- ── 53. service_role WITH an actor succeeds; WITHOUT one fails closed ────────
-- The REST api_key path in one pair of assertions: the edge function resolves
-- the token's owner and names them, and a service-role call that names nobody
-- gets nothing — `lorekit_org_can(null, …)` is false via a NULL role.
do $$
declare
  v_denied_no_actor boolean := false;
  v_denied_outsider boolean := false;
  v_members int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- WITH an actor who is the owner: allowed.
  perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Renamed By Service Role',
                             '00000000-0000-0000-0000-00000000ac01');

  -- WITHOUT an actor: the actor resolves to NULL and everything denies.
  begin
    perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Renamed By Nobody');
  exception when sqlstate 'LK002' then v_denied_no_actor := true; end;

  -- WITH an actor who is not a member: denied. Naming an actor is not a
  -- capability grant — it only says WHO is asking.
  begin
    perform lorekit_org_rename('00000000-0000-0000-0000-00000000ac10', 'Renamed By Outsider',
                               '00000000-0000-0000-0000-00000000ac02');
  exception when sqlstate 'LK002' then v_denied_outsider := true; end;

  -- The membership-gated read behaves the same way.
  select count(*) into v_members
    from lorekit_org_members_list('00000000-0000-0000-0000-00000000ac10',
                                  '00000000-0000-0000-0000-00000000ac01');
  reset role;

  assert (select name from orgs where id = '00000000-0000-0000-0000-00000000ac10') = 'Renamed By Service Role',
    'service_role naming the owner as p_actor_user_id must be able to rename';
  assert v_denied_no_actor,
    'FAIL-CLOSED: service_role with no p_actor_user_id must be denied (auth.uid() is NULL there)';
  assert v_denied_outsider,
    'service_role naming a NON-MEMBER as p_actor_user_id must be denied — the override is an identity, not a grant';
  assert v_members = 4,
    format('lorekit_org_members_list: service_role naming a member should see all 4 members, got %s', v_members);
end;
$$;

-- ── 54. service_role reads fail closed with no actor / a non-member actor ────
do $$
declare
  v_none int;
  v_outsider int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count(*) into v_none
    from lorekit_org_members_list('00000000-0000-0000-0000-00000000ac10');
  select count(*) into v_outsider
    from lorekit_org_members_list('00000000-0000-0000-0000-00000000ac10',
                                  '00000000-0000-0000-0000-00000000ac02');
  reset role;

  assert v_none = 0,
    format('FAIL-CLOSED: lorekit_org_members_list with no actor must return an empty set, got %s rows', v_none);
  assert v_outsider = 0,
    format('lorekit_org_members_list: a non-member actor must see nothing, got %s rows', v_outsider);
end;
$$;

-- ── 55. lorekit_org_create: a NULL actor RAISES; an explicit actor owns ──────
-- create has no `lorekit_org_can` gate to fail closed on (it IS the
-- owner-bootstrap path), so 00041 gives it an explicit guard. Without it a
-- service-role call with no actor would insert an org whose `created_by` is
-- NULL and then trip the NOT NULL on `org_members.user_id` — a confusing
-- 500 instead of an honest 403.
do $$
declare
  v_raised boolean := false;
  v_org_id uuid;
  v_before int;
  v_after  int;
begin
  select count(*) into v_before from orgs;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  begin
    perform lorekit_org_create('actor-null-org', 'Should Never Exist');
  exception when sqlstate 'LK002' then v_raised := true; end;

  -- With an explicit actor it works, and that actor becomes the sole owner.
  select lorekit_org_create('actor-service-org', 'Service Created Org',
                            '00000000-0000-0000-0000-00000000ac02') into v_org_id;
  reset role;

  assert v_raised,
    'lorekit_org_create: a service_role call with no resolvable actor must raise LK002, not create an ownerless org';
  assert not exists (select 1 from orgs where slug = 'actor-null-org'),
    'lorekit_org_create: the ownerless org must not have been inserted';

  assert v_org_id is not null, 'lorekit_org_create: an actor-named create must return the new org id';
  assert (select created_by from orgs where id = v_org_id) = '00000000-0000-0000-0000-00000000ac02',
    'lorekit_org_create: created_by must be the named actor, not NULL';
  assert (select count(*) from org_members where org_id = v_org_id) = 1,
    'lorekit_org_create: exactly one membership row must be created';
  assert (select role from org_members where org_id = v_org_id) = 'owner'
     and (select user_id from org_members where org_id = v_org_id) = '00000000-0000-0000-0000-00000000ac02',
    'lorekit_org_create: the named actor must be the sole owner';

  select count(*) into v_after from orgs;
  assert v_after = v_before + 1,
    format('lorekit_org_create: expected exactly one new org, orgs went from %s to %s', v_before, v_after);
end;
$$;

-- ── 56. The remaining actor-aware RPCs work end-to-end over service_role ─────
-- invite -> revoke, role change, member removal. Each is exercised with the
-- ADMIN as the named actor (not the owner) so the capability matrix is
-- genuinely consulted rather than trivially satisfied.
do $$
declare
  v_invite_id uuid;
  v_denied_member boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A plain member named as the actor cannot invite: the role matrix still rules.
  begin
    perform lorekit_org_invite('00000000-0000-0000-0000-00000000ac10', 'nope@test.local', null, 'member',
                               '00000000-0000-0000-0000-00000000ac03');
  exception when sqlstate 'LK002' then v_denied_member := true; end;

  select lorekit_org_invite('00000000-0000-0000-0000-00000000ac10', 'actor-invite@test.local', null, 'member',
                            '00000000-0000-0000-0000-00000000ac04') into v_invite_id;

  perform lorekit_org_invite_revoke(v_invite_id, '00000000-0000-0000-0000-00000000ac04');

  perform lorekit_org_member_role('00000000-0000-0000-0000-00000000ac10',
                                  '00000000-0000-0000-0000-00000000ac05', 'viewer',
                                  '00000000-0000-0000-0000-00000000ac04');

  perform lorekit_org_member_remove('00000000-0000-0000-0000-00000000ac10',
                                    '00000000-0000-0000-0000-00000000ac05',
                                    '00000000-0000-0000-0000-00000000ac04');
  reset role;

  assert v_denied_member,
    'lorekit_org_invite: a member named as the actor must still be denied the invite capability';
  assert (select invited_by from org_invites where id = v_invite_id) = '00000000-0000-0000-0000-00000000ac04',
    'lorekit_org_invite: invited_by must record the NAMED actor, not NULL';
  assert (select status from org_invites where id = v_invite_id) = 'revoked',
    'lorekit_org_invite_revoke: the invite must be revoked by the named actor';
  assert not exists (select 1 from org_members
                      where org_id = '00000000-0000-0000-0000-00000000ac10'
                        and user_id = '00000000-0000-0000-0000-00000000ac05'),
    'lorekit_org_member_remove: the target must be removed by the named actor';
end;
$$;

-- ── 57. lorekit_org_delete is STILL a soft delete after the recreate ─────────
-- 00041 re-creates several functions that were last defined in 00024/00025,
-- not 00022. Copying the 00022 body would have silently reverted the
-- soft-delete introduced by 00025 — a real, permanent data-loss regression
-- that no other assertion in this file would catch. This is that guard.
do $$
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform lorekit_org_delete('00000000-0000-0000-0000-00000000ac11',
                             '00000000-0000-0000-0000-00000000ac01');
  reset role;

  assert exists (select 1 from orgs where id = '00000000-0000-0000-0000-00000000ac11'),
    'REGRESSION: lorekit_org_delete hard-deleted the row — 00041 must keep 00025''s soft delete';
  assert (select deleted_at from orgs where id = '00000000-0000-0000-0000-00000000ac11') is not null,
    'lorekit_org_delete: deleted_at must be stamped';
  assert not exists (
    select 1 from lorekit_member_org_ids('00000000-0000-0000-0000-00000000ac01') as t(org_id)
     where t.org_id = '00000000-0000-0000-0000-00000000ac11'),
    'lorekit_org_delete: a soft-deleted org must drop out of lorekit_member_org_ids';
end;
$$;

-- ── 58. Exactly one overload of each recreated RPC exists ────────────────────
-- 00041 DROPs before re-creating. A `create or replace` would instead have
-- left the old signature in place, and PostgREST's named-argument resolution
-- would then fail with "could not choose the best candidate function" on
-- every call from the dashboard — an outage, not a degradation.
do $$
declare
  v_fn   text;
  v_n    int;
  v_fns  text[] := array[
    'lorekit_org_create', 'lorekit_org_rename', 'lorekit_org_delete',
    'lorekit_org_invite', 'lorekit_org_invite_revoke',
    'lorekit_org_member_remove', 'lorekit_org_member_role',
    'lorekit_org_members_list'
  ];
begin
  assert array_length(v_fns, 1) = 8,
    'overload guard: expected 8 functions to check (anti-vacuity)';

  foreach v_fn in array v_fns loop
    select count(*) into v_n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    assert v_n = 1,
      format('%s has %s overloads — 00041 must DROP the pre-existing signature, not create a second one', v_fn, v_n);

    -- ...and the surviving one must actually accept the new parameter.
    assert exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn
         and 'p_actor_user_id' = any (p.proargnames)),
      format('%s does not declare p_actor_user_id', v_fn);
  end loop;

  -- The three deliberately-untouched RPCs must NOT have gained one.
  foreach v_fn in array array['lorekit_org_invite_accept', 'lorekit_org_invite_decline', 'lorekit_org_leave'] loop
    assert not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn
         and 'p_actor_user_id' = any (p.proargnames)),
      format('%s gained an actor override — accept/decline match the invite against VERIFIED JWT identity claims, which service_role has no equivalent of (see 00041''s header)', v_fn);
  end loop;
end;
$$;

-- ── 59. EXECUTE grants survived the drop/recreate ────────────────────────────
-- DROP FUNCTION discards the grants with the function. Losing them would turn
-- every dashboard org action into a permission-denied error.
do $$
declare
  v_sig text;
  v_sigs text[] := array[
    'lorekit_org_actor(uuid)',
    'lorekit_org_create(text, text, uuid)',
    'lorekit_org_rename(uuid, text, uuid)',
    'lorekit_org_delete(uuid, uuid)',
    'lorekit_org_invite(uuid, text, text, text, uuid)',
    'lorekit_org_invite_revoke(uuid, uuid)',
    'lorekit_org_member_remove(uuid, uuid, uuid)',
    'lorekit_org_member_role(uuid, uuid, text, uuid)',
    'lorekit_org_members_list(uuid, uuid)'
  ];
begin
  assert array_length(v_sigs, 1) = 9,
    'grant guard: expected 9 signatures to check (anti-vacuity)';

  foreach v_sig in array v_sigs loop
    assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
      format('authenticated lost EXECUTE on %s', v_sig);
    assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
      format('service_role lost EXECUTE on %s', v_sig);
  end loop;

  -- PII-bearing and identity-resolving functions stay off `anon`, unchanged
  -- from 00024/00022.
  assert not has_function_privilege('anon', 'lorekit_org_members_list(uuid, uuid)', 'EXECUTE'),
    'lorekit_org_members_list must not be granted to anon — it returns other users'' handles and avatars';
  assert not has_function_privilege('anon', 'lorekit_org_actor(uuid)', 'EXECUTE'),
    'lorekit_org_actor must not be granted to anon';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 60. Memory RPC actor guard — 00046_memory_rpc_actor_guard.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- archive_memory / restore_memory / purge_archived_memories /
-- purge_expired_memories are SECURITY DEFINER and act on a caller-supplied
-- p_user_id. 00046 makes that id inert for any non-service-role caller: the
-- effective actor is auth.uid() unless the connection is service-role. These
-- assertions are the security case the migration turns on — an authenticated
-- caller naming another user's id must mutate NOTHING of that user's — plus a
-- self-service regression check and a behavioural read-hiding check.

insert into memories (user_id, scope, key, value, archived_at, expires_at) values
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-archived', 'd4 archived', now() - interval '90 days', null),
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-expired',  'd4 expired',  null, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-active',   'd4 active',   null, null),
  ('00000000-0000-0000-0000-0000000000e5', 'project::actor-guard-mig', 'ag-e5',       'e5 active',   null, null);

-- ── 60a. NEGATIVE: an authenticated caller cannot act on another user ────────
-- e5 is authenticated and names d4 on every RPC. The guard forces e5's own id,
-- so each call operates on e5's (empty) row set and d4's rows are untouched.
do $$
declare
  v_purged_arch int;
  v_purged_exp  int;
  v_arch_id     uuid;
  -- 00072 replaced `restore_memory`'s `returns uuid` with
  -- `returns table (restored boolean, existed boolean)`, so the call is a FROM
  -- item now and the guard reads `restored` instead of "an id came back".
  r_rest        record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);

  select purge_archived_memories('00000000-0000-0000-0000-0000000000d4', 0) into v_purged_arch;
  select purge_expired_memories('00000000-0000-0000-0000-0000000000d4')     into v_purged_exp;
  select archive_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-active')   into v_arch_id;
  select * into r_rest
    from restore_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-archived');

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_purged_arch = 0,
    format('IDOR: e5 hard-deleted %s of d4''s archived rows by naming d4 as p_user_id', v_purged_arch);
  assert v_purged_exp = 0,
    format('IDOR: e5 hard-deleted %s of d4''s expired rows by naming d4 as p_user_id', v_purged_exp);
  assert v_arch_id is null,
    'IDOR: e5 archived one of d4''s rows by naming d4 as p_user_id';
  assert not r_rest.restored,
    'IDOR: e5 restored one of d4''s rows by naming d4 as p_user_id';

  -- d4's three rows are all exactly as seeded.
  assert exists (select 1 from memories
                 where user_id='00000000-0000-0000-0000-0000000000d4'
                   and key='ag-archived' and archived_at is not null),
    'IDOR: d4''s archived row was purged or restored by e5';
  assert exists (select 1 from memories
                 where user_id='00000000-0000-0000-0000-0000000000d4' and key='ag-expired'),
    'IDOR: d4''s expired row was purged by e5';
  assert exists (select 1 from memories
                 where user_id='00000000-0000-0000-0000-0000000000d4'
                   and key='ag-active' and archived_at is null),
    'IDOR: d4''s active row was archived by e5';
end;
$$;

-- ── 60b. Self-service still works — d4 acting as itself ──────────────────────
do $$
declare
  v_arch_id    uuid;
  -- See 60a: 00072 made `restore_memory` a table-returning function.
  r_rest       record;
  v_purged_exp int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);

  select archive_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-active')   into v_arch_id;
  select * into r_rest
    from restore_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-archived');
  select purge_expired_memories('00000000-0000-0000-0000-0000000000d4') into v_purged_exp;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_arch_id is not null, 'self-service: d4 archiving its OWN active row must succeed';
  assert r_rest.restored,       'self-service: d4 restoring its OWN archived row must succeed';
  assert v_purged_exp >= 1,     'self-service: d4 purging its OWN expired row must delete it';
  assert not exists (select 1 from memories
                     where user_id='00000000-0000-0000-0000-0000000000d4' and key='ag-expired'),
    'self-service: d4''s expired row should be gone after its own purge';
end;
$$;

-- ── 60c. Read-hiding is the read TOOLS' job, not RLS ────────────────────────
-- The article's most-wanted assertion: an archived or expired row is absent
-- from what a read returns. The crucial subtlety is WHERE that hiding happens.
-- `memories` has TWO permissive SELECT policies — `rls_read` (archived_at is
-- null) AND `rls_read_archived` (archived_at is NOT null, for the dashboard
-- Archive tab, 00003/00015) — and permissive policies OR, so an OWNER's plain
-- SELECT returns BOTH active and archived rows. Expiry is not in RLS at all.
-- What actually hides archived AND expired rows from a read is the query-layer
-- predicate the read tools apply together — read.ts/list.ts/search.ts:
--   .is('archived_at', null).or('expires_at.is.null,expires_at.gt.now()')
-- So this replicates that exact tool predicate (both clauses), and separately
-- shows raw RLS does NOT hide either — proving the filters, not RLS, are load-
-- bearing. (A prior version wrongly assumed RLS hid archived rows; it does not.)
insert into memories (user_id, scope, key, value, archived_at, expires_at) values
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-read', 'hidden-archived', 'x', now(), null),
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-read', 'hidden-expired',  'x', null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-read', 'visible-active',  'x', null, null);

do $$
declare
  v_active_tool       int;
  v_archived_tool     int;
  v_expired_tool      int;
  v_archived_raw_rls  int;
  v_expired_raw_rls   int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);

  -- Under the read tools' exact predicate (both filters together).
  select count(*) into v_active_tool
    from memories where scope='project::actor-guard-read' and key='visible-active'
     and archived_at is null and (expires_at is null or expires_at > now());
  select count(*) into v_archived_tool
    from memories where scope='project::actor-guard-read' and key='hidden-archived'
     and archived_at is null and (expires_at is null or expires_at > now());
  select count(*) into v_expired_tool
    from memories where scope='project::actor-guard-read' and key='hidden-expired'
     and archived_at is null and (expires_at is null or expires_at > now());

  -- Raw RLS, no tool predicate: the owner still sees BOTH rows.
  select count(*) into v_archived_raw_rls
    from memories where scope='project::actor-guard-read' and key='hidden-archived';
  select count(*) into v_expired_raw_rls
    from memories where scope='project::actor-guard-read' and key='hidden-expired';

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_active_tool = 1,
    'read-hiding: an active row must be visible through the read tools'' predicate';
  assert v_archived_tool = 0,
    'read-hiding: the read tools'' archived_at-is-null filter must exclude an archived row';
  assert v_expired_tool = 0,
    'read-hiding: the read tools'' (expires_at is null or expires_at > now()) filter must exclude an expired row';
  assert v_archived_raw_rls = 1,
    'read-hiding: raw RLS exposes an owner''s archived row (rls_read_archived) — the tool filter, not RLS, is what hides it';
  assert v_expired_raw_rls = 1,
    'read-hiding: expiry is app-layer, so raw RLS still returns an expired row — the tool filter, not RLS, is what hides it';
end;
$$;

-- ── 60d. Grant guard: least-privilege EXECUTE, never anon ────────────────────
do $$
declare
  v_sig  text;
  v_sigs text[] := array[
    'archive_memory(uuid, text, text)',
    -- 00072 recreated `restore_memory` with the calling key's restriction
    -- appended (p_key_scopes, p_key_org_access, p_key_org_ids → 6 args), for the
    -- same reason 00069 did it to `memory_delete` below: name the CURRENT
    -- signature, or `has_function_privilege` ERRORS on a function that no longer
    -- exists and aborts the whole run.
    'restore_memory(uuid, text, text, text[], text, uuid[])',
    'purge_archived_memories(uuid, integer)',
    'purge_expired_memories(uuid)',
    -- 00069 appended the calling key's restriction (p_key_scopes, p_key_org_access,
    -- p_key_org_ids → 8 args). The grant guard names a signature, so a recreate
    -- that changes the parameter list leaves this pointing at a function that no
    -- longer exists and `has_function_privilege` ERRORS rather than failing.
    'memory_delete(uuid, text, text, text, boolean, text[], text, uuid[])'
  ];
begin
  assert array_length(v_sigs, 1) = 5,
    'grant guard: expected 5 signatures to check (anti-vacuity)';

  foreach v_sig in array v_sigs loop
    assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
      format('authenticated lost EXECUTE on %s', v_sig);
    assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
      format('service_role lost EXECUTE on %s', v_sig);
    assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
      format('%s must not be executable by anon after 00046 (default PUBLIC grant revoked)', v_sig);
  end loop;
end;
$$;

-- ── 60e. POSITIVE: the service-role branch honours a named p_user_id ─────────
-- Invariant 5 of 00046 — the edge/MCP purge path. On a verified service-role
-- connection a supplied p_user_id IS honoured (coalesce(p_user_id, auth.uid())),
-- so the RPC acts on exactly the named user. Without this the edge purge path
-- could regress to a NULL actor silently. e5 owns the rows; a service-role
-- caller names e5 and its expired/archived rows are purged.
insert into memories (user_id, scope, key, value, archived_at, expires_at) values
  ('00000000-0000-0000-0000-0000000000e5', 'project::actor-guard-svc', 'svc-expired',  'x', null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e5', 'project::actor-guard-svc', 'svc-archived', 'x', now() - interval '90 days', null);

do $$
declare
  v_purged_exp  int;
  v_purged_arch int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select purge_expired_memories('00000000-0000-0000-0000-0000000000e5') into v_purged_exp;
  select purge_archived_memories('00000000-0000-0000-0000-0000000000e5', 0) into v_purged_arch;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_purged_exp = 1,
    format('service-role branch: purge_expired_memories must honour the named p_user_id and delete e5''s expired row, got %s', v_purged_exp);
  assert v_purged_arch = 1,
    format('service-role branch: purge_archived_memories must honour the named p_user_id and delete e5''s archived row, got %s', v_purged_arch);
  assert not exists (select 1 from memories where scope='project::actor-guard-svc'),
    'service-role branch: both of e5''s rows should be physically gone after the service-role purge';
end;
$$;

-- ── 60f. NEGATIVE: memory_delete cannot be driven against another user ───────
-- memory_delete (00020) is the destructive sibling added to the 00046 family:
-- an authenticated caller naming another user's id must archive/delete NOTHING
-- of that user's, and self-service must still work.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-del', 'del-victim', 'd4 owns this');

do $$
declare
  r_force   record;
  r_archive record;
  r_self    record;
begin
  -- Attacker e5 (authenticated) names victim d4 on both force and soft paths.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);

  select * into r_force
    from memory_delete('00000000-0000-0000-0000-0000000000d4', null, 'project::actor-guard-del', 'del-victim', true);
  select * into r_archive
    from memory_delete('00000000-0000-0000-0000-0000000000d4', null, 'project::actor-guard-del', 'del-victim', false);
  reset role;

  assert not r_force.deleted,
    'IDOR: e5 hard-deleted d4''s row via memory_delete by naming d4 as p_user_id';
  assert not r_archive.archived,
    'IDOR: e5 archived d4''s row via memory_delete by naming d4 as p_user_id';
  assert exists (select 1 from memories
                 where user_id='00000000-0000-0000-0000-0000000000d4'
                   and key='del-victim' and archived_at is null),
    'IDOR: d4''s row was mutated by e5''s memory_delete';

  -- Self-service: d4 archives, then hard-deletes, its OWN row.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
  select * into r_self
    from memory_delete('00000000-0000-0000-0000-0000000000d4', null, 'project::actor-guard-del', 'del-victim', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert r_self.deleted,
    'self-service: d4 hard-deleting its OWN row via memory_delete must succeed';
  assert not exists (select 1 from memories
                     where user_id='00000000-0000-0000-0000-0000000000d4' and key='del-victim'),
    'self-service: d4''s row should be gone after its own hard-delete';
end;
$$;

-- ── 60g. POSITIVE: memory_delete's org branch under an AUTHENTICATED caller ──
-- §18 exercises the org branch under service_role (the edge api_key path); this
-- covers the OTHER actor path — an authenticated member acting as ITSELF, so
-- the actor resolves to auth.uid() and lorekit_org_can(auth.uid(), ...) stays
-- tested. d4 is a member of phase2-org (f2) with the 'archive' capability
-- (established in §16-18).
insert into memories (org_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000f2', 'global', 'p2-authpath-key', 'v');

do $$
declare r record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);

  select * into r
    from memory_delete('00000000-0000-0000-0000-0000000000d4', 'phase2-org', 'global', 'p2-authpath-key', false);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert r.archived and not r.deleted,
    format('memory_delete org branch: an authenticated member must archive via the auth.uid() actor path (archived=%s deleted=%s)', r.archived, r.deleted);
end;
$$;
-- ── Usage statistics — 00043 / 00044 / 00045 ────────────────────────────────
-- lorekit_usage_stats(p_user_id, p_since, p_until, p_correlation_id) backs GET
-- /memories/usage. It aggregates usage_events (00034 + the 00044 dimensions) in
-- Postgres, so these assertions are the only place the self-only visibility
-- predicate, the half-open [since, until) window, the service-role escape hatch,
-- the record_count roll-up (G1) and the correlation filter (G2) are executed.
-- AC-1: A caller sees ONLY their own events, grouped by (tool, outcome, scope).
-- AC-2: The window is half-open — p_since is inclusive, older rows excluded.
-- AC-3: Rows come back sorted by event_count desc.
-- AC-4: service-role (verified role claim) + NULL p_user_id sees everything (CI).
-- AC-5: A non-service caller passing NULL p_user_id gets nothing (fails closed).
-- AC-6: Granted to authenticated + service_role, never anon.
-- AC-7: record_count sums result_count — the "read N RECORDS" figure (G1, 00044).
-- AC-8: p_correlation_id narrows to one PR/session (G2, 00044).
-- AC-9: purge_expired_memories records a memory.expired event = rows expired (G3, 00045).

-- Isolate this section's fixture: earlier sections (the TTL purge tests) now emit
-- a memory.expired usage event for a1 as a side effect of 00045, which would push
-- a1's exact-total assertions below off by one. Clear both test users' ledgers so
-- the counts assert only the rows this section seeds.
delete from usage_events
 where user_id in ('00000000-0000-0000-0000-0000000000a1',
                   '00000000-0000-0000-0000-0000000000b2');

-- User A (a1): 7 events — 3 recent list/ok/repo (10 records each → 30), 1 recent
-- write/ok/repo, 1 recent write/cap_exceeded/repo, and 2 OLD (40d) list/ok/global
-- for the window test. The three recent list rows + the recent write carry a
-- correlation id 'pr-42' for the G2 filter test. User B (b2): 1 event A never sees.
insert into usage_events (user_id, plan_name, tool_name, scope_type, auth_type, outcome, duration_ms, result_count, correlation_id, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',  'repo',   'api_key', 'ok',           10,   10, 'pr-42', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',  'repo',   'api_key', 'ok',           10,   10, 'pr-42', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',  'repo',   'api_key', 'ok',           10,   10, 'pr-42', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.write', 'repo',   'api_key', 'ok',           20, null, 'pr-42', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.write', 'repo',   'api_key', 'cap_exceeded',  5, null, null,    now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',  'global', 'api_key', 'ok',           10,    5, null,    now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',  'global', 'api_key', 'ok',           10,    5, null,    now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000b2', 'free', 'memory.read',  'global', 'jwt',     'ok',           10,    1, null,    now() - interval '10 minutes');

do $$
declare
  v_sum   bigint;
  v_rows  int;
  v_top   text;
begin
  -- AC-1: A's all-time total is exactly its own 7 events (not 8 — B's leaks nowhere).
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null);
  assert v_sum = 7, format('usage AC-1: A must total 7 own events, got %s', v_sum);

  -- AC-1: grouping — the three recent list/ok/repo rows collapse to one bucket of 3.
  select event_count into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   where tool_name = 'memory.list' and outcome = 'ok' and scope_type = 'repo';
  assert v_sum = 3, format('usage AC-1: (memory.list,ok,repo) must be 3, got %s', v_sum);

  -- AC-1: the cap-hit is its own outcome bucket.
  select event_count into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   where tool_name = 'memory.write' and outcome = 'cap_exceeded';
  assert v_sum = 1, format('usage AC-1: (memory.write,cap_exceeded) must be 1, got %s', v_sum);

  -- AC-1: A never sees B's event (B's only tool is memory.read).
  select count(*) into v_rows
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   where tool_name = 'memory.read';
  assert v_rows = 0, 'usage AC-1: A must not see B''s memory.read event';

  -- AC-2: a 7-day window excludes the two 40-day-old global rows (7 - 2 = 5),
  -- and the global bucket disappears entirely.
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', now() - interval '7 days', null);
  assert v_sum = 5, format('usage AC-2: 7-day window must total 5, got %s', v_sum);
  select count(*) into v_rows
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', now() - interval '7 days', null)
   where scope_type = 'global';
  assert v_rows = 0, 'usage AC-2: the 40-day-old global bucket must be outside a 7-day window';

  -- AC-3: sorted by event_count desc — the 3-row list bucket is first.
  select tool_name into v_top
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   limit 1;
  assert v_top = 'memory.list', format('usage AC-3: top row must be memory.list (count 3), got %s', v_top);

  -- B sees only its own single event.
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000b2', null, null);
  assert v_sum = 1, format('usage AC-1: B must total 1 own event, got %s', v_sum);

  -- AC-7 (G1): record_count is the SUM of result_count, distinct from the call
  -- count — the (memory.list,ok,repo) bucket is 3 CALLS but 30 RECORDS read.
  select record_count into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   where tool_name = 'memory.list' and outcome = 'ok' and scope_type = 'repo';
  assert v_sum = 30, format('usage AC-7: (memory.list,ok,repo) record_count must be 30, got %s', v_sum);

  -- AC-8 (G2): the correlation filter narrows to the 'pr-42' events only — the 3
  -- recent list calls + the 1 recent write (4 events), NOT the cap-hit or the
  -- 40-day-old global rows (which carry no correlation id).
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null, 'pr-42');
  assert v_sum = 4, format('usage AC-8: pr-42 correlation must total 4 events, got %s', v_sum);
  -- And its records-read is the same 30 (the pr-42 list bucket).
  select record_count into v_sum
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null, 'pr-42')
   where tool_name = 'memory.list';
  assert v_sum = 30, format('usage AC-8: pr-42 list record_count must be 30, got %s', v_sum);
  -- An unknown correlation id yields nothing.
  select count(*) into v_rows
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null, 'no-such-pr');
  assert v_rows = 0, 'usage AC-8: an unmatched correlation id must return no rows';
end;
$$;

-- AC-4 + AC-5: the NULL-p_user_id branch depends on the VERIFIED role claim.
do $$
declare
  v_sum bigint;
begin
  -- AC-4: a service_role caller with NULL p_user_id sees every user's events (CI
  -- escape hatch) — A's 7 plus B's 1.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats(null, null, null);
  assert v_sum >= 8, format('usage AC-4: service-role NULL must see all events (>=8), got %s', v_sum);

  -- AC-5: an authenticated caller passing NULL p_user_id gets nothing — the
  -- escape hatch is gated on the verified role, so it fails closed.
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select coalesce(sum(event_count), 0) into v_sum
    from lorekit_usage_stats(null, null, null);
  assert v_sum = 0, format('usage AC-5: authenticated NULL p_user_id must fail closed (0), got %s', v_sum);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-9 (G3): purge_expired_memories records ONE memory.expired usage event whose
-- result_count equals the rows it deleted. Insert a fresh already-expired memory
-- for A, purge, and assert the recorded expiry count matches the purge return
-- (>= 1; other expired rows from earlier sections may raise it — the equality
-- to v_purged is what proves the count is captured, not discarded).
insert into memories (user_id, scope, key, value, expires_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::usage-expiry', 'ue-1', 'v', now() - interval '1 minute');

do $$
declare
  v_purged   integer;
  v_recorded bigint;
  v_expired  bigint;
begin
  -- Since 00046, purge_expired_memories honours a caller-supplied p_user_id only
  -- on a service-role connection (the actor guard) — which is how the edge/MCP
  -- purge path invokes it. Adopt that context so this assertion exercises the
  -- real purge-by-id instead of resolving to a NULL auth.uid() actor.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_purged := purge_expired_memories('00000000-0000-0000-0000-0000000000a1');
  assert v_purged >= 1, format('usage AC-9: purge must delete at least the 1 expired row, got %s', v_purged);

  -- The synthetic expiry event carries the purged count as its result_count.
  select result_count into v_recorded
    from usage_events
   where user_id = '00000000-0000-0000-0000-0000000000a1'
     and tool_name = 'memory.expired'
   order by created_at desc
   limit 1;
  assert v_recorded = v_purged,
    format('usage AC-9: memory.expired result_count (%s) must equal rows purged (%s)', v_recorded, v_purged);

  -- And it surfaces through the stats RPC as the memory.expired bucket's record_count.
  select record_count into v_expired
    from lorekit_usage_stats('00000000-0000-0000-0000-0000000000a1', null, null)
   where tool_name = 'memory.expired';
  assert v_expired = v_purged,
    format('usage AC-9: stats memory.expired record_count (%s) must equal rows purged (%s)', v_expired, v_purged);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-6: grant surface — authenticated + service_role, never anon (the function
-- takes a bare p_user_id, so anon EXECUTE would expose any user's aggregates).
-- Signature is the 00044 4-arg form (added p_correlation_id).
do $$
declare
  v_sig text := 'lorekit_usage_stats(uuid, timestamp with time zone, timestamp with time zone, text)';
begin
  assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    'usage AC-6: authenticated must have EXECUTE on lorekit_usage_stats';
  assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
    'usage AC-6: service_role must have EXECUTE on lorekit_usage_stats';
  assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
    'usage AC-6: lorekit_usage_stats must NOT be granted to anon';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 61. Read-function grant hardening — 00047_readfn_grant_hardening.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- The clearly-safe half of the deferred grant sweep: the caller-supplied-
-- p_user_id read RPCs (lorekit_memory_scopes/_count) get the actor guard and
-- lose anon EXECUTE; the service-role-only functions (find_user_by_github_id,
-- the installation RPCs, the two purge procedures) lose PUBLIC EXECUTE.

-- ── 61a. Grant surface ──────────────────────────────────────────────────────
do $$
declare
  v_sig  text;
  -- Reads: authenticated + service_role, never anon.
  v_read text[] := array[
    -- 00069 appended the key restriction (4 args) — see the note in 60d.
    'lorekit_memory_scopes(uuid, text[], text, uuid[])',
    'lorekit_memory_count(uuid)'
  ];
  -- Service-role-only: never anon, never authenticated.
  v_svc  text[] := array[
    'lorekit_find_user_by_github_id(text)',
    'lorekit_installation_upsert(bigint, bigint, text, text, uuid, text, text[])',
    'lorekit_installation_remove_repos(bigint, text[])',
    'lorekit_installation_remove(bigint)',
    'lorekit_purge_old_usage_events(interval)',
    'lorekit_purge_all_expired_memories()'
  ];
begin
  assert array_length(v_read, 1) = 2 and array_length(v_svc, 1) = 6,
    'readfn grant guard: expected 2 read + 6 service-only signatures (anti-vacuity)';

  foreach v_sig in array v_read loop
    assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
      format('%s must NOT be executable by anon after 00047', v_sig);
    assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
      format('%s must stay executable by authenticated', v_sig);
    assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
      format('%s must stay executable by service_role', v_sig);
  end loop;

  foreach v_sig in array v_svc loop
    assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
      format('%s must NOT be executable by anon after 00047', v_sig);
    assert not has_function_privilege('authenticated', v_sig, 'EXECUTE'),
      format('%s must NOT be executable by authenticated after 00047 (service-role only)', v_sig);
    assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
      format('%s must stay executable by service_role', v_sig);
  end loop;
end;
$$;

-- ── 61b. Actor guard: an authenticated caller cannot read another user ──────
-- a1 owns a distinctively-named scope. An authenticated b2 naming a1 must see
-- NONE of a1's scopes/counts (resolved to b2's own auth.uid()); a service-role
-- caller naming a1 sees a1's, as the edge GET /memories/scopes path does.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::readfn-guard-secret', 'k', 'v');

do $$
declare
  v_svc_scopes  int;
  v_svc_null    int;
  v_b2_scopes   int;
  v_b2_count    jsonb;
  v_b2_personal int;
  v_a1_personal int;
begin
  -- Ground truth for the count assertion below, computed the way
  -- lorekit_memory_count computes personal_count (active = not archived; the
  -- personal branch deliberately does not filter on expires_at). b2 is NOT a
  -- blank user in this fixture — earlier sections give it its own rows — so
  -- the property is "b2 sees b2's own total", never a hardcoded zero.
  select count(*) into v_b2_personal from memories
   where user_id = '00000000-0000-0000-0000-0000000000b2' and archived_at is null;
  select count(*) into v_a1_personal from memories
   where user_id = '00000000-0000-0000-0000-0000000000a1' and archived_at is null;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select count(*) into v_svc_scopes
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::readfn-guard-secret';
  -- CI escape hatch: a service-role caller with NULL p_user_id sees EVERY
  -- scope (v_actor resolves NULL → the `v_actor is null and service_role`
  -- branch), so a1's secret scope is visible without naming any user.
  select count(*) into v_svc_null
    from lorekit_memory_scopes(null)
   where scope = 'project::readfn-guard-secret';
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  select count(*) into v_b2_scopes
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::readfn-guard-secret';
  select lorekit_memory_count('00000000-0000-0000-0000-0000000000a1') into v_b2_count;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_svc_scopes = 1,
    format('readfn guard: service-role naming a1 must see a1''s scope, got %s', v_svc_scopes);
  assert v_svc_null = 1,
    format('readfn guard: service-role NULL p_user_id (CI escape hatch) must see a1''s scope, got %s', v_svc_null);
  assert v_b2_scopes = 0,
    format('readfn guard: authenticated b2 naming a1 must NOT enumerate a1''s scopes (IDOR closed), got %s', v_b2_scopes);
  -- Anti-vacuity: the two users' active personal totals must differ, otherwise
  -- "b2 got b2's number" and "b2 got a1's number" would be indistinguishable
  -- and the assertion below could not prove the actor was pinned.
  assert v_a1_personal <> v_b2_personal,
    format('readfn guard fixture: a1 and b2 must hold a different number of active personal rows for the count assertion to be meaningful (a1=%s, b2=%s)',
           v_a1_personal, v_b2_personal);
  assert coalesce((v_b2_count->>'personal_count')::int, -1) = v_b2_personal,
    format('readfn guard: authenticated b2 memory_count(a1) must report b2''s OWN personal total (%s), not a1''s (%s), got %s',
           v_b2_personal, v_a1_personal, v_b2_count->>'personal_count');
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Memory origin (provenance) — memory_write's four origin params (00048)
-- ═════════════════════════════════════════════════════════════════════════

-- ── 62. origin: INSERT stores all four fields; UPSERT keeps the last KNOWN
-- value for a field the newer write omits (AC: never regress to unknown) ────
do $$
declare
  v_id1 uuid;
  v_id2 uuid;
  v_row record;
begin
  select id into v_id1
    from memory_write(
      '00000000-0000-0000-0000-0000000000e5', 'global', 'origin-key', 'v1',
      '{}'::text[], null, null, null, null, null, false,
      'mthines/lorekit', 'feat/Origin-Provenance', 'abc1234def5678', 42);

  select * into v_row from memories where id = v_id1;
  assert v_row.origin_repo = 'mthines/lorekit',
    format('origin insert: origin_repo should be stored, got %s', v_row.origin_repo);
  assert v_row.origin_branch = 'feat/Origin-Provenance',
    format('origin insert: origin_branch must keep its verbatim case, got %s', v_row.origin_branch);
  assert v_row.origin_commit = 'abc1234def5678',
    format('origin insert: origin_commit should be stored, got %s', v_row.origin_commit);
  assert v_row.origin_pr = 42,
    format('origin insert: origin_pr should be stored, got %s', v_row.origin_pr);

  -- A second write from the same branch that does NOT know the commit or PR
  -- (an agent with no CI context) must not erase what the first write knew.
  select id into v_id2
    from memory_write(
      '00000000-0000-0000-0000-0000000000e5', 'global', 'origin-key', 'v2',
      '{}'::text[], null, null, null, null, null, false,
      null, 'feat/Later-Branch', null, null);

  assert v_id2 = v_id1, 'origin upsert: should update the existing row, not insert a new one';
  select * into v_row from memories where id = v_id1;
  assert v_row.value = 'v2', 'origin upsert: value should be updated';
  assert v_row.origin_branch = 'feat/Later-Branch',
    format('origin upsert: a supplied origin_branch must win, got %s', v_row.origin_branch);
  assert v_row.origin_repo = 'mthines/lorekit',
    format('origin upsert: an omitted origin_repo must be preserved, got %s', v_row.origin_repo);
  assert v_row.origin_commit = 'abc1234def5678',
    format('origin upsert: an omitted origin_commit must be preserved, got %s', v_row.origin_commit);
  assert v_row.origin_pr = 42,
    format('origin upsert: an omitted origin_pr must be preserved, got %s', v_row.origin_pr);
end;
$$;

-- ── 63. origin: every field is optional — a write that supplies none still
-- succeeds and leaves all four NULL (back-compat with every existing caller) ─
do $$
declare
  v_id  uuid;
  v_row record;
begin
  select id into v_id
    from memory_write('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-none-key', 'v');
  select * into v_row from memories where id = v_id;
  assert v_row.origin_repo is null and v_row.origin_branch is null
     and v_row.origin_commit is null and v_row.origin_pr is null,
    'origin: a write with no origin params must leave all four columns NULL';
end;
$$;

-- ── 64. origin: the CHECK constraints are the backstop for anything that
-- bypasses the app-layer validator (a direct SQL insert, a future client) ────
do $$
declare
  v_rejected boolean;
  v_case     text;
begin
  v_rejected := false;
  begin
    insert into memories (user_id, scope, key, value, origin_pr)
    values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-bad-pr', 'v', 0);
  exception when check_violation then v_rejected := true;
  end;
  assert v_rejected, 'origin: origin_pr = 0 must be rejected by memories_origin_pr_check';

  v_rejected := false;
  begin
    insert into memories (user_id, scope, key, value, origin_commit)
    values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-bad-sha', 'v', 'HEAD');
  exception when check_violation then v_rejected := true;
  end;
  assert v_rejected, 'origin: a non-hex origin_commit must be rejected by memories_origin_commit_check';

  v_rejected := false;
  begin
    insert into memories (user_id, scope, key, value, origin_repo)
    values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-bad-repo', 'v', 'lorekit');
  exception when check_violation then v_rejected := true;
  end;
  assert v_rejected, 'origin: an origin_repo without a slash must be rejected by memories_origin_repo_check';

  -- Path traversal: "../evil" is a well-formed owner/name to a naive check, and
  -- https://github.com/../evil resolves in the browser to github.com/evil — a
  -- link to a repository the memory never came from.
  for v_case in select unnest(array['../evil', 'a/..', './x', 'owner/../evil']) loop
    v_rejected := false;
    begin
      insert into memories (user_id, scope, key, value, origin_repo)
      values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-trav-' || v_case, 'v', v_case);
    exception when check_violation then v_rejected := true;
    end;
    assert v_rejected,
      format('origin: origin_repo %L must be rejected as a relative path', v_case);
  end loop;

  v_rejected := false;
  begin
    insert into memories (user_id, scope, key, value, origin_branch)
    values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-trav-branch', 'v', 'feat/../../x');
  exception when check_violation then v_rejected := true;
  end;
  assert v_rejected, 'origin: an origin_branch with a .. segment must be rejected';

  -- ...and the legitimate shapes still pass, so the guard is not vacuous.
  insert into memories (user_id, scope, key, value, origin_repo, origin_branch)
  values ('00000000-0000-0000-0000-0000000000e5', 'global', 'origin-ok', 'v',
          'my-org/repo.name_1', 'fix/issue#123');
end;
$$;

-- ── 65. origin: grant surface — the widened memory_write signature is granted
-- to the same three roles the 11-arg form was (00038); 00056 further widened it
-- with p_kind + p_host (17 args) ────────────────────────────────────────────
do $$
declare
  -- 00069 appended the key restriction (p_key_scopes, p_key_org_access,
  -- p_key_org_ids → 20 args).
  v_sig text := 'memory_write(uuid, text, text, text, text[], text, text, timestamp with time zone, text, integer, boolean, text, text, text, integer, text, text, text[], text, uuid[])';
begin
  assert has_function_privilege('anon', v_sig, 'EXECUTE'),
    'origin: anon must have EXECUTE on the widened memory_write';
  assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    'origin: authenticated must have EXECUTE on the widened memory_write';
  assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
    'origin: service_role must have EXECUTE on the widened memory_write';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- Dashboard aggregate reads — 00049 / 00050 / 00051
--
-- The dashboard used to compute all three of these in the browser from a
-- capped `select … limit 1000`, which is silently wrong past PostgREST's row
-- cap. These functions move the aggregation into Postgres, so — exactly as for
-- lorekit_memory_scopes (§47) — this file is the only place their visibility
-- predicate, partitioning and ordering are actually executed.
-- ═════════════════════════════════════════════════════════════════════════

-- Fixtures: user A (a1) gets labelled rows in both partitions plus two rows with
-- pinned created_at values in distinct UTC days/hours. User B (b2) gets a
-- labelled row of their own so the tenant predicate has something to exclude.
insert into memories (user_id, scope, key, value, tags) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-a', 'agg-1', 'v', array['perf','auth']),
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-a', 'agg-2', 'v', array['perf']);
insert into memories (user_id, scope, key, value, tags, archived_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-a', 'agg-archived', 'v', array['retired'], now());
insert into memories (user_id, scope, key, value, tags, expires_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-a', 'agg-expired', 'v', array['ghost'], now() - interval '1 minute');
insert into memories (user_id, scope, key, value, tags) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::agg-b', 'agg-b-1', 'v', array['bee']);

insert into memories (user_id, scope, key, value, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-t', 'agg-t-1', 'v', timestamptz '2026-03-01 01:15:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-t', 'agg-t-2', 'v', timestamptz '2026-03-01 01:45:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'project::agg-t', 'agg-t-3', 'v', timestamptz '2026-03-02 05:00:00+00');

-- ── 66. lorekit_memory_scopes exposes last_activity (00049) ─────────────────
-- AC-1: last_activity is max(created_at) over exactly the counted rows.
-- AC-2: the archived / expired siblings that are excluded from `count` are
--       excluded from `last_activity` too (one predicate, not two).
do $$
declare
  v_last     timestamptz;
  v_expected timestamptz;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select last_activity into v_last
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::agg-t';
  select max(created_at) into v_expected
    from memories
   where user_id = '00000000-0000-0000-0000-0000000000a1'
     and scope = 'project::agg-t';
  assert v_last = v_expected,
    format('scopes last_activity AC-1: expected %s, got %s', v_expected, v_last);

  -- project::agg-a holds an archived and an already-expired row created AFTER
  -- the two active ones, so a last_activity computed over the wrong row set
  -- would be strictly greater than the active maximum.
  select last_activity into v_last
    from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1')
   where scope = 'project::agg-a';
  select max(created_at) into v_expected
    from memories
   where user_id = '00000000-0000-0000-0000-0000000000a1'
     and scope = 'project::agg-a'
     and archived_at is null
     and (expires_at is null or expires_at > now());
  assert v_last = v_expected,
    format('scopes last_activity AC-2: archived/expired rows must not move last_activity (expected %s, got %s)', v_expected, v_last);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 67. lorekit_memory_tags — the label catalog (00050) ─────────────────────
-- AC-1: counts every visible ACTIVE row carrying the label.
-- AC-2: archived and expired rows are excluded from the active partition.
-- AC-3: p_archived => true returns the archived partition instead.
-- AC-4: another user's labels are never counted.
-- AC-5: an org co-member sees labels on org-owned rows.
-- AC-6: ordering is count desc, then tag asc.
do $$
declare
  v_count  bigint;
  v_rows   int;
  v_tags   text[];
  v_sorted text[];
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: 'perf' is on both active rows.
  select count into v_count
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false)
   where tag = 'perf';
  assert v_count = 2, format('memory tags AC-1: perf must count 2, got %s', v_count);

  -- AC-2: the archived-only and expired-only labels are absent from the active
  -- catalog altogether — not present with a zero count.
  select count(*) into v_rows
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false)
   where tag in ('retired', 'ghost');
  assert v_rows = 0,
    'memory tags AC-2: archived and expired rows must not contribute to the active catalog';

  -- AC-3: the archived partition is the archived rows' labels, and only those.
  select count into v_count
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', true)
   where tag = 'retired';
  assert v_count = 1, format('memory tags AC-3: retired must count 1 in the archived partition, got %s', v_count);
  select count(*) into v_rows
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', true)
   where tag = 'perf';
  assert v_rows = 0, 'memory tags AC-3b: an active-only label must not appear in the archived partition';

  -- AC-4: B's label is invisible to A, and vice versa.
  select count(*) into v_rows
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false)
   where tag = 'bee';
  assert v_rows = 0, 'memory tags AC-4: a caller must never see another user''s labels';

  -- AC-5: an org-owned row's labels reach every co-member (user_id IS NULL, so
  -- only the lorekit_member_org_ids branch of the predicate can admit it).
  insert into memories (user_id, org_id, scope, key, value, tags) values
    (null, '00000000-0000-0000-0000-0000000000fa', 'repo::acme/scopes-org', 'agg-org-1', 'v', array['shared']);
  select count into v_count
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000b2', false)
   where tag = 'shared';
  assert v_count = 1, format('memory tags AC-5: an org co-member must see the org row''s label, got %s', v_count);

  -- AC-6: count desc, then tag asc — a picker that reshuffles for equal counts
  -- moves options out from under the cursor.
  select array_agg(tag) into v_tags from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false);
  select array_agg(t.tag order by t.count desc, t.tag asc) into v_sorted
    from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false) t;
  assert v_tags = v_sorted,
    format('memory tags AC-6: results must be ordered count desc, tag asc, got %s', v_tags);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 68. lorekit_memory_activity — per-bucket creation counts (00051) ────────
-- AC-1: day buckets are UTC-midnight-anchored and count the rows in each day.
-- AC-2: hour buckets split a single day at the UTC hour boundary.
-- AC-3: the [since, until) window is half-open.
-- AC-4: another user's rows are never counted.
-- AC-5: an invalid bucket unit raises rather than being interpolated.
do $$
declare
  v_count   bigint;
  v_rows    int;
  v_bucket  timestamptz;
  v_raised  boolean;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: two rows on 2026-03-01, one on 2026-03-02, both anchored at midnight.
  select bucket, count into v_bucket, v_count
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-03-01 00:00:00+00', timestamptz '2026-03-03 00:00:00+00')
   where scope = 'project::agg-t'
   order by bucket asc
   limit 1;
  assert v_bucket = timestamptz '2026-03-01 00:00:00+00',
    format('memory activity AC-1: first day bucket must be UTC midnight, got %s', v_bucket);
  assert v_count = 2, format('memory activity AC-1: 2026-03-01 must count 2, got %s', v_count);

  -- AC-2: both of those rows fall in the SAME hour bucket (01:00), so the hour
  -- granularity must still produce one row of 2 — not two rows of 1.
  select count(*) into v_rows
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-03-01 00:00:00+00', timestamptz '2026-03-02 00:00:00+00')
   where scope = 'project::agg-t';
  assert v_rows = 1, format('memory activity AC-2: 2026-03-01 must yield exactly one hour bucket, got %s', v_rows);
  select bucket, count into v_bucket, v_count
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-03-01 00:00:00+00', timestamptz '2026-03-02 00:00:00+00')
   where scope = 'project::agg-t';
  assert v_bucket = timestamptz '2026-03-01 01:00:00+00' and v_count = 2,
    format('memory activity AC-2: expected the 01:00 bucket with 2 rows, got %s / %s', v_bucket, v_count);

  -- AC-3: `until` is EXCLUSIVE — a window ending exactly at the second day's
  -- midnight must not pick up 2026-03-02, and `since` is inclusive.
  select count(*) into v_rows
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-03-01 00:00:00+00', timestamptz '2026-03-02 00:00:00+00')
   where scope = 'project::agg-t';
  assert v_rows = 1, format('memory activity AC-3: the window must be half-open, got %s buckets', v_rows);

  -- AC-4: B's rows are invisible to A.
  select count(*) into v_rows
    from lorekit_memory_activity('00000000-0000-0000-0000-0000000000a1', 'day', null, null)
   where scope = 'project::agg-b';
  assert v_rows = 0, 'memory activity AC-4: a caller must never see another user''s activity';

  -- AC-5: p_bucket is a bounded categorical. It is a date_trunc ARGUMENT, not
  -- interpolated SQL, so this is not an injection guard — it is what turns an
  -- opaque 22023 from inside date_trunc into a named, catchable error.
  v_raised := false;
  begin
    perform * from lorekit_memory_activity('00000000-0000-0000-0000-0000000000a1', 'week', null, null);
  exception when others then
    v_raised := true;
  end;
  assert v_raised, 'memory activity AC-5: an unsupported bucket unit must raise';

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 68b. lorekit_memory_activity — scope + dimension filters (00063) ────────
-- The Explorer's stat header follows the filter bar, so the activity RPC gained
-- the same predicate GET /memories and lorekit_memory_facets apply. Most of the
-- operator matrix is §69's proven logic, so §68b proves the plumbing — and the
-- `nin` / origin_pr-coercion arms that are fresh plpgsql in 00063 get their own
-- assertions in §68c (just below §69), once the facet-a fixtures that carry an
-- agent and a PR exist.
-- AC-1: a dimension filter narrows the counts to the list's set.
-- AC-2: scope is a hard filter.
-- AC-3: a NO-MATCH filter yields ZERO — never a fallback to the account total,
--       which would show account numbers under an empty scope's name.
-- AC-4: tags 'none' is an EXCLUSION arm — it drops overlapping rows.
do $$
declare
  v_sum bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: both ACTIVE agg-a rows carry 'perf' (the archived/expired siblings do
  -- not count), so a perf filter over agg-a sums to 2.
  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day', null, null,
      'project::agg-a', array['perf']);
  assert v_sum = 2, format('activity filter AC-1: perf under agg-a must sum to 2, got %s', v_sum);

  -- Only agg-1 carries 'auth'.
  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day', null, null,
      'project::agg-a', array['auth']);
  assert v_sum = 1, format('activity filter AC-1b: auth under agg-a must sum to 1, got %s', v_sum);

  -- AC-3: a no-match filter must yield nothing, not the account-wide total.
  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day', null, null,
      'project::agg-a', array['does-not-exist']);
  assert v_sum = 0, format('activity filter AC-3: a no-match filter must yield 0, got %s', v_sum);

  -- AC-2: p_scope is a hard filter — no other scope's rows leak into the result.
  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day', null, null,
      'project::agg-a')
   where scope <> 'project::agg-a';
  assert v_sum = 0, 'activity filter AC-2: p_scope must exclude every other scope';

  -- AC-4: an EXCLUSION arm — tags 'none' drops the rows that overlap the set.
  -- Only agg-1 carries 'auth', so excluding it leaves agg-2 → 1.
  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day', null, null,
      'project::agg-a', array['auth'], 'none');
  assert v_sum = 1, format('activity filter AC-4: tags none [auth] must leave 1, got %s', v_sum);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 69. lorekit_memory_facets — the multi-dimension value catalog (00052) ───
-- AC-1: every dimension is enumerated with its per-value count, including the
--       text[] `tags` unnest and the integer `origin_pr` cast to text.
-- AC-2: NULL and blank column values yield no row at all — an option that
--       matches by absence needs an operator the list route does not have.
-- AC-3: the archived / expired partition rule is lorekit_memory_tags' verbatim.
-- AC-4: another user's values are never counted.
-- AC-5: an org co-member sees values on org-owned rows.
-- AC-6: ordering is facet asc, count desc, value asc.
-- AC-7: the `tag` rows agree exactly with lorekit_memory_tags — the two
--       endpoints overlap deliberately, so the agreement is executed, not
--       asserted in a comment.
insert into memories (user_id, scope, key, value, tags, source_agent, trigger, origin_repo, origin_branch, origin_pr) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::facet-a', 'facet-1', 'v', array['perf'], 'aw',     'stuck-loop', 'mthines/lorekit', 'main', 311),
  ('00000000-0000-0000-0000-0000000000a1', 'project::facet-a', 'facet-2', 'v', array['perf'], 'aw',     'stuck-loop', 'mthines/lorekit', 'feat/x', 311),
  -- Every provenance column NULL, and a deliberately blank agent: neither may
  -- produce a facet row.
  ('00000000-0000-0000-0000-0000000000a1', 'project::facet-a', 'facet-3', 'v', array['perf'], '   ',    null,         null,              null,    null);
insert into memories (user_id, scope, key, value, source_agent, archived_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::facet-a', 'facet-archived', 'v', 'retired-agent', now());
insert into memories (user_id, scope, key, value, source_agent) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::facet-b', 'facet-b-1', 'v', 'bee-agent');

do $$
declare
  v_count    bigint;
  v_rows     int;
  v_pairs    text[];
  v_sorted   text[];
  v_facet_ct bigint;
  v_tag_ct   bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: one row per (dimension, value), counted over the visible active set.
  select count into v_count
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where facet = 'source_agent' and value = 'aw';
  assert v_count = 2, format('memory facets AC-1: source_agent aw must count 2, got %s', v_count);

  select count into v_count
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where facet = 'origin_branch' and value = 'main';
  assert v_count = 1, format('memory facets AC-1b: origin_branch main must count 1, got %s', v_count);

  -- The integer column is rendered as text ONCE, here, so no consumer has to.
  select count into v_count
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where facet = 'origin_pr' and value = '311';
  assert v_count = 2, format('memory facets AC-1c: origin_pr 311 must count 2 as TEXT, got %s', v_count);

  -- AC-2: the all-NULL row contributes no provenance value, and the blank
  -- agent contributes no agent value.
  select count(*) into v_rows
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where value is null or btrim(value) = '';
  assert v_rows = 0, 'memory facets AC-2: a null or blank column value must yield no facet row';

  -- AC-3: the archived row's agent is absent from the active partition and
  -- present in the archived one.
  select count(*) into v_rows
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where facet = 'source_agent' and value = 'retired-agent';
  assert v_rows = 0, 'memory facets AC-3: an archived row must not contribute to the active catalog';
  select count into v_count
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', true)
   where facet = 'source_agent' and value = 'retired-agent';
  assert v_count = 1, format('memory facets AC-3b: the archived partition must hold it, got %s', v_count);

  -- AC-4: B's values are invisible to A.
  select count(*) into v_rows
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false)
   where value = 'bee-agent';
  assert v_rows = 0, 'memory facets AC-4: a caller must never see another user''s values';

  -- AC-5: an org-owned row (user_id IS NULL) reaches every co-member, so only
  -- the lorekit_member_org_ids branch of the predicate can admit it.
  insert into memories (user_id, org_id, scope, key, value, source_agent) values
    (null, '00000000-0000-0000-0000-0000000000fa', 'repo::acme/facets-org', 'facet-org-1', 'v', 'org-agent');
  select count into v_count
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000b2', false)
   where facet = 'source_agent' and value = 'org-agent';
  assert v_count = 1, format('memory facets AC-5: an org co-member must see the org row''s value, got %s', v_count);

  -- AC-6: facet asc, count desc, value asc — a picker that reshuffles for equal
  -- counts moves options out from under the cursor.
  select array_agg(facet || '/' || value) into v_pairs
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false);
  select array_agg(f.facet || '/' || f.value order by f.facet asc, f.count desc, f.value asc) into v_sorted
    from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false) f;
  assert v_pairs = v_sorted,
    format('memory facets AC-6: results must be ordered facet asc, count desc, value asc, got %s', v_pairs);

  -- AC-7: the tag rows are lorekit_memory_tags' rows. GET /memories/tags and
  -- GET /memories/facets both answer "what labels exist"; if these two ever
  -- disagree, one of the two endpoints is lying to its callers.
  -- A symmetric EXCEPT rather than an outer join: a join predicate would need
  -- its own NULL handling, and "the two sets differ" is exactly what EXCEPT
  -- answers, in both directions.
  select count(*) into v_rows from (
    (select f.value, f.count
       from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false) f
      where f.facet = 'tag'
     except
     select t.tag, t.count
       from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false) t)
    union all
    (select t.tag, t.count
       from lorekit_memory_tags('00000000-0000-0000-0000-0000000000a1', false) t
     except
     select f.value, f.count
       from lorekit_memory_facets('00000000-0000-0000-0000-0000000000a1', false) f
      where f.facet = 'tag')
  ) d;
  assert v_rows = 0, 'memory facets AC-7: the tag facet must equal the lorekit_memory_tags catalog';

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 68c. lorekit_memory_activity — `nin` + origin_pr coercion (00063) ────────
-- The arms of the activity predicate that are fresh plpgsql in 00063 — a scalar
-- `nin` and the integer origin_pr coercion — asserted here (not in §68b) because
-- they need a fixture carrying a source_agent and a PR, which §69's facet-a rows
-- already do: facet-1/facet-2 are agent `aw` / PR 311, facet-3 has a blank agent
-- and no PR. All three are active, so a bare facet-a scope sums to 3.
-- AC-1: source_agent `nin [aw]` excludes the two `aw` rows → facet-3 alone → 1.
-- AC-2: origin_pr's digits-only coercion drops the non-numeric decoy and matches
--       311 alone → facet-1 + facet-2 → 2.
-- AC-3: an all-non-numeric origin_pr list coerces to empty and applies NO filter
--       (00063's rationale), not a match-nothing → all three active rows → 3.
do $$
declare
  v_sum bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity('00000000-0000-0000-0000-0000000000a1', 'day',
      p_scope => 'project::facet-a', p_source_agent => array['aw'], p_source_agent_mode => 'nin');
  assert v_sum = 1, format('activity AC-1: source_agent nin [aw] under facet-a must leave 1, got %s', v_sum);

  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity('00000000-0000-0000-0000-0000000000a1', 'day',
      p_scope => 'project::facet-a', p_origin_pr => array['abc', '311']);
  assert v_sum = 2, format('activity AC-2: origin_pr [abc,311] must coerce to 311 → 2, got %s', v_sum);

  select coalesce(sum(count), 0) into v_sum
    from lorekit_memory_activity('00000000-0000-0000-0000-0000000000a1', 'day',
      p_scope => 'project::facet-a', p_origin_pr => array['not-a-pr']);
  assert v_sum = 3, format('activity AC-3: an empty coerced origin_pr must not filter → 3, got %s', v_sum);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 69b. lorekit_memory_facets drill-down + kind/host (00057) ────────────────
-- AC-1: kind and host are enumerated as their own dimensions.
-- AC-2: DRILL-DOWN — an active filter on one dimension narrows the counts of
--       the OTHER dimensions, so a value's count is what selecting it yields.
-- AC-3: SELF-EXCLUSION — a dimension's own filter does NOT collapse its own
--       other values, so multi-select stays discoverable.
-- AC-4: the `tag` dimension's `cross join lateral unnest` branch drills down
--       like the scalar ones — it is the only structurally different cell.
-- AC-5: `nin` mode is a distinct `case` arm and must self-exclude too.
-- AC-6: `origin_pr` is compared NUMERICALLY, so `007` matches PR 7 exactly as
--       it does on `GET /memories`, and an all-non-numeric list filters nothing.
-- Fresh user id `…dd` so only these three rows are visible — counts are exact.
-- It owns no other row anywhere in this file, which is what makes every count
-- below exact; it therefore needs its own `auth.users` seed to satisfy
-- `memories.user_id`'s FK (00001), like the other late-introduced identities.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000dd', 'authenticated', 'authenticated', 'lk-mig-dd@test.local', now(), now());

insert into memories (user_id, scope, key, value, source_agent, kind, host, tags, origin_pr) values
  ('00000000-0000-0000-0000-0000000000dd', 'project::facet-dd', 'dd-1', 'v', 'aw',  'lesson', 'reviewer', array['dd-alpha','dd-shared'], 7),
  ('00000000-0000-0000-0000-0000000000dd', 'project::facet-dd', 'dd-2', 'v', 'aw',  'lesson', 'aw',       array['dd-shared'],            7),
  ('00000000-0000-0000-0000-0000000000dd', 'project::facet-dd', 'dd-3', 'v', 'bee', 'signal', 'reviewer', array['dd-beta','dd-shared'],  42);

do $$
declare
  v_count bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: kind + host appear as dimensions with global counts.
  select count into v_count from lorekit_memory_facets(p_user_id => '00000000-0000-0000-0000-0000000000dd')
   where facet = 'kind' and value = 'lesson';
  assert v_count = 2, format('facets drill-down AC-1: kind lesson must count 2, got %s', v_count);
  select count into v_count from lorekit_memory_facets(p_user_id => '00000000-0000-0000-0000-0000000000dd')
   where facet = 'host' and value = 'reviewer';
  assert v_count = 2, format('facets drill-down AC-1b: host reviewer must count 2, got %s', v_count);

  -- AC-2: filter kind=lesson → host `reviewer` narrows from 2 to 1 (only dd-1;
  -- dd-3 is a signal). This is the whole point of drill-down.
  select count into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'in')
   where facet = 'host' and value = 'reviewer';
  assert v_count = 1, format('facets drill-down AC-2: host reviewer under kind=lesson must be 1, got %s', v_count);

  -- AC-3: the SAME kind filter must NOT collapse the kind dimension's own
  -- values — self-exclusion keeps signal=1 visible so the user can switch.
  select count into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'in')
   where facet = 'kind' and value = 'signal';
  assert v_count = 1, format('facets drill-down AC-3: self-exclusion must keep kind signal=1 under kind=lesson, got %s', v_count);

  -- AC-4: the tag dimension is the ONE cell built with `cross join lateral
  -- unnest`, so its drill-down is structurally different from the scalar ones
  -- and is asserted on its own. `dd-shared` is on all three rows, so kind=lesson
  -- narrows it 3 → 2; `dd-beta` lives only on the signal row, so it disappears.
  -- `coalesce(sum(...))` because an absent value emits NO row at all.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'in') f
   where f.facet = 'tag' and f.value = 'dd-shared';
  assert v_count = 2, format('facets drill-down AC-4: tag dd-shared under kind=lesson must be 2, got %s', v_count);
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'in') f
   where f.facet = 'tag' and f.value = 'dd-beta';
  assert v_count = 0, format('facets drill-down AC-4b: tag dd-beta must not survive kind=lesson, got %s', v_count);

  -- AC-4c: the tag dimension SELF-EXCLUDES too — filtering on `dd-alpha` must
  -- not collapse the tag dimension to that one value, or the user could never
  -- switch labels from a drilled-down menu.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_tags => array['dd-alpha'], p_tags_mode => 'any') f
   where f.facet = 'tag' and f.value = 'dd-beta';
  assert v_count = 1, format('facets drill-down AC-4c: tag self-exclusion must keep dd-beta=1 under tags=dd-alpha, got %s', v_count);

  -- AC-5: `nin` is its own `case` arm. Under kind NOT IN (lesson) the host
  -- dimension narrows to the signal row only (1), while the kind dimension
  -- self-excludes and still reports its own excluded value (lesson = 2).
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'nin') f
   where f.facet = 'host' and f.value = 'reviewer';
  assert v_count = 1, format('facets drill-down AC-5: host reviewer under kind nin lesson must be 1, got %s', v_count);
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_kind => array['lesson'], p_kind_mode => 'nin') f
   where f.facet = 'kind' and f.value = 'lesson';
  assert v_count = 2, format('facets drill-down AC-5b: nin self-exclusion must keep kind lesson=2, got %s', v_count);

  -- AC-6: `origin_pr` is an integer column, so the filter is compared
  -- numerically — `007` must match PR 7 exactly as it does on `GET /memories`,
  -- which sends the digits-only value bare to the integer column.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_origin_pr => array['007'], p_origin_pr_mode => 'in') f
   where f.facet = 'kind' and f.value = 'lesson';
  assert v_count = 2, format('facets drill-down AC-6: zero-padded origin_pr 007 must match PR 7 (kind lesson = 2), got %s', v_count);

  -- AC-6b: a list with no numeric entry left applies NO filter, rather than
  -- matching nothing — again the list route's documented behaviour.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000dd',
      p_origin_pr => array['not-a-number'], p_origin_pr_mode => 'in') f
   where f.facet = 'kind' and f.value = 'lesson';
  assert v_count = 2, format('facets drill-down AC-6b: a non-numeric origin_pr list must not filter (kind lesson = 2), got %s', v_count);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 69c. owner as a facet DIMENSION + the RPC owner predicate (00064) ────────
-- Ownership was the ONE Explorer filter narrowed client-side; 00064 folds it
-- into the same drill-down machinery as every other dimension. Owner identity is
-- `personal` (org_id null) or the owning org's SLUG. This covers the two RPCs
-- (`lorekit_memory_facets` and `lorekit_memory_activity`). The equivalent
-- `GET /memories` list predicate (`applyOwnerFilter`) shares the SAME identity
-- rule but runs at the PostgREST layer, so this SQL suite cannot reach it — and
-- it has NO automated coverage yet: `memories-api.integration.spec.ts` has a
-- `list filters` block for the other dimensions but no `owner` case. Adding one
-- is the open follow-up; until then the list predicate is verified by hand
-- against the RPC identity rule these ACs pin.
-- AC-1: the owner facet enumerates `personal` and the org slug with counts.
-- AC-2: DRILL-DOWN — an owner filter narrows the OTHER dimensions' counts.
-- AC-3: SELF-EXCLUSION — the owner filter does not collapse the owner dimension,
--       so both owner values stay switchable from a drilled-in menu.
-- AC-4: `nin` excludes the named identity (personal → org rows only).
-- AC-5: activity applies the SAME predicate (personal-only / org-only / a
--       no-match yielding zero), so the stat header agrees with the list.
-- Fresh user `…ec` + org `…fc` (slug `owner-org`): the user owns 2 personal rows
-- and, as a member of `…fc`, sees 1 org-owned row — so every count is exact and
-- isolated from the rest of the file.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000ec', 'authenticated', 'authenticated', 'lk-mig-ec@test.local', now(), now());

insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000000fc', 'owner-org', 'Owner Org', '00000000-0000-0000-0000-0000000000ec');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000fc', '00000000-0000-0000-0000-0000000000ec', 'owner');

-- Two personal rows (org_id null) with a shared agent, and one org-owned row
-- (user_id null, org_id set) with a different agent — so a drill-down over the
-- owner filter has an OTHER dimension to narrow.
insert into memories (user_id, org_id, scope, key, value, source_agent) values
  ('00000000-0000-0000-0000-0000000000ec', null,                                     'project::owner-p',        'op-1', 'v', 'ec-agent'),
  ('00000000-0000-0000-0000-0000000000ec', null,                                     'project::owner-p',        'op-2', 'v', 'ec-agent'),
  (null,                                    '00000000-0000-0000-0000-0000000000fc', 'repo::acme/owner-org',    'oo-1', 'v', 'org-agent');

do $$
declare
  v_count bigint;
  v_sum   bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: the owner facet enumerates `personal` (2 rows) and the org slug (1).
  select count into v_count from lorekit_memory_facets(p_user_id => '00000000-0000-0000-0000-0000000000ec')
   where facet = 'owner' and value = 'personal';
  assert v_count = 2, format('owner facet AC-1: owner personal must count 2, got %s', v_count);
  select count into v_count from lorekit_memory_facets(p_user_id => '00000000-0000-0000-0000-0000000000ec')
   where facet = 'owner' and value = 'owner-org';
  assert v_count = 1, format('owner facet AC-1b: owner owner-org (slug) must count 1, got %s', v_count);

  -- AC-2: filter owner=personal → source_agent narrows to the personal rows'
  -- agent (ec-agent = 2) and the org agent disappears.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['personal'], p_owner_mode => 'in') f
   where f.facet = 'source_agent' and f.value = 'ec-agent';
  assert v_count = 2, format('owner facet AC-2: source_agent ec-agent under owner=personal must be 2, got %s', v_count);
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['personal'], p_owner_mode => 'in') f
   where f.facet = 'source_agent' and f.value = 'org-agent';
  assert v_count = 0, format('owner facet AC-2b: org-agent must not survive owner=personal, got %s', v_count);

  -- Filter owner=owner-org (by SLUG) → only the org row's agent survives.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['owner-org'], p_owner_mode => 'in') f
   where f.facet = 'source_agent' and f.value = 'org-agent';
  assert v_count = 1, format('owner facet AC-2c: source_agent org-agent under owner=owner-org must be 1, got %s', v_count);

  -- AC-3: SELF-EXCLUSION — the owner filter must NOT collapse the owner
  -- dimension's own values, so the other owner stays switchable.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['personal'], p_owner_mode => 'in') f
   where f.facet = 'owner' and f.value = 'owner-org';
  assert v_count = 1, format('owner facet AC-3: self-exclusion must keep owner owner-org=1 under owner=personal, got %s', v_count);

  -- AC-4: `nin` excludes the personal partition → only the org row's agent.
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['personal'], p_owner_mode => 'nin') f
   where f.facet = 'source_agent' and f.value = 'org-agent';
  assert v_count = 1, format('owner facet AC-4: source_agent org-agent under owner nin personal must be 1, got %s', v_count);
  select coalesce(sum(f.count), 0) into v_count from lorekit_memory_facets(
      p_user_id => '00000000-0000-0000-0000-0000000000ec',
      p_owner => array['personal'], p_owner_mode => 'nin') f
   where f.facet = 'source_agent' and f.value = 'ec-agent';
  assert v_count = 0, format('owner facet AC-4b: ec-agent must not survive owner nin personal, got %s', v_count);

  -- AC-5: activity applies the SAME predicate, so the stat header agrees.
  select coalesce(sum(count), 0) into v_sum from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000ec', 'day', null, null,
      p_owner => array['personal']);
  assert v_sum = 2, format('owner activity AC-5: owner=personal must sum to 2, got %s', v_sum);

  select coalesce(sum(count), 0) into v_sum from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000ec', 'day', null, null,
      p_owner => array['owner-org']);
  assert v_sum = 1, format('owner activity AC-5b: owner=owner-org must sum to 1, got %s', v_sum);

  select coalesce(sum(count), 0) into v_sum from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000ec', 'day', null, null,
      p_owner => array['personal'], p_owner_mode => 'nin');
  assert v_sum = 1, format('owner activity AC-5c: owner nin personal must sum to 1, got %s', v_sum);

  -- A slug the caller cannot resolve (not a member org) matches NOTHING, never a
  -- fallback to the account total.
  select coalesce(sum(count), 0) into v_sum from lorekit_memory_activity(
      '00000000-0000-0000-0000-0000000000ec', 'day', null, null,
      p_owner => array['no-such-org']);
  assert v_sum = 0, format('owner activity AC-5d: an unresolvable owner slug must yield 0, got %s', v_sum);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 70. lorekit_memory_facets grant surface — PII-adjacent, so no anon ──────
-- Branch names, repo names and agent names are at least as sensitive as the
-- scope names 00039 withholds, so the grant set is that function's verbatim.
do $$
declare
  -- 00057 widened the signature with the drill-down filter params (19 args);
  -- 00064 appended the owner dimension (p_owner, p_owner_mode → 21 args).
  -- 00069 appended the key restriction (p_key_scopes, p_key_org_access,
  -- p_key_org_ids → 24 args).
  v_sig text := 'lorekit_memory_facets(uuid, boolean, text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, uuid[])';
begin
  assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
    'memory facets: anon must NOT have EXECUTE';
  assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    'memory facets: authenticated must have EXECUTE';
  assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
    'memory facets: service_role must have EXECUTE';
end;
$$;


-- ── 71. lorekit_read_activity — per-bucket read volume (00053) ──────────────
-- Backs GET /memories/read-activity, the Overview's "Memories read" card.
-- AC-1: result_count is SUMMED per bucket — the card's bars add up to its number.
-- AC-2: only the read tools count; a write event in the same bucket is excluded,
--       and EVERY name in permissions.ts's READ_TOOLS counts — including
--       memory.list_archived, which usage-stats.ts also classifies as a read.
-- AC-3: the [since, until) window is half-open, and day buckets are UTC-anchored.
-- AC-4: SELF-ONLY — another user's read events are never visible (usage is a
--       per-user ledger; there is no org sharing of read events).
-- AC-5: service-role + NULL p_user_id is the CI escape hatch and sees everything.
-- AC-6: an invalid bucket unit raises rather than reaching date_trunc.

-- This section's fixture is dated in 2026-04 so it cannot collide with the
-- usage-statistics section above, which asserts exact all-time totals for a1
-- over rows it seeds itself.
insert into usage_events (user_id, plan_name, tool_name, scope_type, auth_type, outcome, duration_ms, result_count, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',   'repo',   'api_key', 'ok', 10,  7, timestamptz '2026-04-01 01:10:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.search', 'repo',   'api_key', 'ok', 10,  3, timestamptz '2026-04-01 01:50:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.write',  'repo',   'api_key', 'ok', 10, 99, timestamptz '2026-04-01 02:00:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.read',   'global', 'api_key', 'ok', 10,  4, timestamptz '2026-04-02 09:00:00+00'),
  -- The fourth READ_TOOLS name. Deliberately on the 2nd, so every 2026-04-01
  -- assertion above is untouched and this row's only effect is the AC-2 total.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list_archived', 'global', 'api_key', 'ok', 10, 6, timestamptz '2026-04-02 09:30:00+00'),
  ('00000000-0000-0000-0000-0000000000b2', 'free', 'memory.list',   'global', 'jwt',     'ok', 10, 50, timestamptz '2026-04-01 01:20:00+00');

do $$
declare
  v_count  bigint;
  v_rows   int;
  v_bucket timestamptz;
begin
  set local role service_role;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"service_role"}', true);

  -- AC-1 + AC-2: the 1st sums 7 + 3 = 10 records; the write event's 99 is excluded.
  select bucket, count into v_bucket, v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-03 00:00:00+00')
   order by bucket asc
   limit 1;
  assert v_bucket = timestamptz '2026-04-01 00:00:00+00',
    format('read activity AC-1: first day bucket must be UTC midnight, got %s', v_bucket);
  assert v_count = 10,
    format('read activity AC-1/AC-2: 2026-04-01 must sum to 10 read records (write excluded), got %s', v_count);

  -- AC-1: hour granularity keeps both reads in the SAME 01:00 bucket.
  select count(*) into v_rows
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-02 00:00:00+00');
  assert v_rows = 1,
    format('read activity AC-1: 2026-04-01 must yield exactly one hour bucket, got %s', v_rows);
  select bucket, count into v_bucket, v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-02 00:00:00+00');
  assert v_bucket = timestamptz '2026-04-01 01:00:00+00' and v_count = 10,
    format('read activity AC-1: expected the 01:00 bucket with 10 records, got %s / %s', v_bucket, v_count);

  -- AC-3: `until` is EXCLUSIVE — a window ending at the 2nd's midnight must not
  -- pick up the 2026-04-02 read; `since` is inclusive.
  select count(*) into v_rows
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-02 00:00:00+00');
  assert v_rows = 1,
    format('read activity AC-3: the window must be half-open, got %s buckets', v_rows);

  -- AC-2: EVERY READ_TOOLS name counts. The 2nd holds memory.read (4) and
  -- memory.list_archived (6). This is the discriminating assertion for the
  -- omitted fourth tool: with a three-name filter it reads 4, not 10.
  select count into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-04-02 00:00:00+00', timestamptz '2026-04-03 00:00:00+00');
  assert v_count = 10,
    format('read activity AC-2: 2026-04-02 must sum memory.read + memory.list_archived = 10, got %s', v_count);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-5: the CI escape hatch — service-role with a NULL p_user_id sees every
-- user's reads, so B's 50 records join A's 10 on 2026-04-01.
--
-- This runs in its OWN block, under claims carrying NO `sub`, because that is
-- the only shape in which the hatch exists: the actor rule resolves
-- `coalesce(p_user_id, auth.uid())` for a service-role caller, so a claim set
-- that names a sub pins the actor to that user and a NULL p_user_id then means
-- "me", not "everyone". A no-sub service_role claim is precisely what the CI
-- connection presents, and it is the shape lorekit_memory_activity's own
-- assertions use.
do $$
declare v_count bigint;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count into v_count
    from lorekit_read_activity(
      null, 'day',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-02 00:00:00+00');
  assert v_count = 60,
    format('read activity AC-5: service-role NULL must total 60 records, got %s', v_count);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-4: self-only. As an AUTHENTICATED user B, A's reads must be invisible —
-- the negative assertion that separates this from the org-shared visibility of
-- lorekit_memory_activity.
do $$
declare v_count bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);

  -- B passes A's id, but the actor is auth.uid() for a non-service caller, so B
  -- can only ever see its own 50 records — never A's 20.
  select coalesce(sum(count), 0) into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-03 00:00:00+00');
  assert v_count = 50,
    format('read activity AC-4: B must see only its own 50 records, got %s', v_count);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-6: p_bucket is a bounded categorical, validated before date_trunc sees it.
do $$
declare v_raised boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform * from lorekit_read_activity('00000000-0000-0000-0000-0000000000a1', 'week', null, null);
  exception when others then
    v_raised := true;
  end;
  assert v_raised, 'read activity AC-6: an unsupported bucket unit must raise';
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 72. usage_events.client — the dashboard stops counting itself (00054) ───
-- The dashboard is a client of LoreKit's own REST API, so drawing the Overview
-- issued real reads that the Overview then counted: the "Memories read" card
-- went up on every page reload. 00054 adds the `client` dimension and excludes
-- the dashboard from lorekit_read_activity.
-- AC-1: a read attributed to `dashboard` is EXCLUDED from the read series.
-- AC-2: a read with a NULL client is still COUNTED — every row written before
--       the column existed is unattributed, and `<>` would have dropped them all.
-- AC-3: a read attributed to any other surface (cli / mcp / api) is COUNTED.
-- AC-4: only the METRIC excludes it — the ledger behind GET /memories/usage
--       still sees the dashboard's records, so the exclusion is reversible.
-- AC-5: the writer RPC persists p_client, and the length CHECK is a real
--       backstop against an unbounded value inflating analytics cardinality.

-- Dated 2026-05 so it cannot collide with §71's 2026-04 fixture or the
-- usage-statistics section's all-time totals.
insert into usage_events (user_id, plan_name, tool_name, scope_type, auth_type, outcome, duration_ms, result_count, client, created_at) values
  -- The bug, reproduced: the dashboard listing lore in order to render it.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list', 'repo', 'jwt',     'ok', 10, 25, 'dashboard', timestamptz '2026-05-01 01:00:00+00'),
  -- An agent actually consuming lore, in the same bucket.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list', 'repo', 'api_key', 'ok', 10,  4, 'mcp',       timestamptz '2026-05-01 01:05:00+00'),
  -- A pre-00054 row: no attribution at all.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.read', 'repo', 'api_key', 'ok', 10,  1, null,        timestamptz '2026-05-01 01:10:00+00');

do $$
declare
  v_count   bigint;
  v_records bigint;
  v_client  text;
  v_id      uuid;
  v_raised  boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"service_role"}', true);

  -- AC-1 + AC-2 + AC-3: 4 (mcp) + 1 (unattributed) = 5. The dashboard's 25 is
  -- gone. This single number is the discriminating assertion for all three:
  -- 30 means nothing was excluded, 4 means the NULL row was wrongly dropped
  -- (the `<>` bug), 25 means the filter is inverted.
  select count into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-05-01 00:00:00+00', timestamptz '2026-05-02 00:00:00+00');
  assert v_count = 5,
    format('usage client AC-1/2/3: 2026-05-01 must read 5 records (dashboard excluded, null + mcp kept), got %s', v_count);

  -- AC-4: the LEDGER is untouched — GET /memories/usage still totals all 30
  -- records read, so nothing was dropped on the way in and the exclusion can be
  -- reversed by one more migration rather than by re-collecting lost data.
  select coalesce(sum(record_count), 0) into v_records
    from lorekit_usage_stats(
      '00000000-0000-0000-0000-0000000000a1',
      timestamptz '2026-05-01 00:00:00+00', timestamptz '2026-05-02 00:00:00+00')
   where tool_name in ('memory.read', 'memory.list', 'memory.search', 'memory.list_archived');
  assert v_records = 30,
    format('usage client AC-4: the ledger must still hold all 30 read records, got %s', v_records);

  -- AC-5: the writer persists the new trailing parameter.
  select lorekit_record_usage_event(
    '00000000-0000-0000-0000-0000000000a1', null, 'free',
    'memory.list', 'repo', 'jwt', 'ok', 5, null, 3, null, 'dashboard') into v_id;
  assert v_id is not null, 'usage client AC-5: the writer must return the inserted id';
  select client into v_client from usage_events where id = v_id;
  assert v_client = 'dashboard',
    format('usage client AC-5: p_client must be persisted, got %s', v_client);

  -- AC-5: the length CHECK is a real backstop, not decoration. The app-side
  -- `parseUsageClient` is the primary gate, but a direct insert must not be
  -- able to put an unbounded value into a column that gets grouped on.
  begin
    insert into usage_events (user_id, tool_name, auth_type, outcome, client)
      values ('00000000-0000-0000-0000-0000000000a1', 'memory.list', 'jwt', 'ok', repeat('x', 33));
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, 'usage client AC-5: an over-long client value must violate the CHECK';

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 73. blog_post_likes — public anonymous cumulative like counter (00055) ──
-- The blog is a public, unauthenticated surface and a like accumulates across
-- ALL visitors, so — uniquely in this schema — the increment RPC is granted to
-- `anon`. The per-session cap is client-side; the server only accumulates the
-- global total and refuses an abusive single call.
-- AC-1: lorekit_blog_like inserts a row on first like and returns the total.
-- AC-2: a second like on the same slug accumulates atomically.
-- AC-3: p_delta is clamped to [1,100] — an over-large delta adds at most 100,
--       and a 0/negative delta is floored to +1 (never a decrement).
-- AC-4: an invalid slug shape is rejected (no junk rows under arbitrary keys).
-- AC-5: `anon` — the unauthenticated blog visitor — can execute the RPC and can
--       SELECT the totals under the public read policy.
-- AC-6: the migration header's claim that a direct PostgREST write "cannot be
--       bypassed" is EXECUTED, not just asserted in prose: an `anon` INSERT is
--       denied outright, and an `anon` UPDATE cannot move an existing total.

do $$
declare
  v_total bigint;
  v_raised boolean := false;
begin
  set local role service_role;

  -- AC-1: first like creates the row.
  select lorekit_blog_like('hello-world', 1) into v_total;
  assert v_total = 1, format('blog likes AC-1: first like must total 1, got %s', v_total);

  -- AC-2: accumulates.
  select lorekit_blog_like('hello-world', 1) into v_total;
  assert v_total = 2, format('blog likes AC-2: second like must total 2, got %s', v_total);

  -- AC-3: an over-large delta is clamped to 100 (2 + 100 = 102).
  select lorekit_blog_like('hello-world', 1000) into v_total;
  assert v_total = 102,
    format('blog likes AC-3: delta 1000 must clamp to +100 (total 102), got %s', v_total);

  -- AC-3: a 0/negative delta is floored to +1, never a decrement.
  select lorekit_blog_like('hello-world', 0) into v_total;
  assert v_total = 103,
    format('blog likes AC-3: delta 0 must floor to +1 (total 103), got %s', v_total);
  select lorekit_blog_like('hello-world', -5) into v_total;
  assert v_total = 104,
    format('blog likes AC-3: negative delta must floor to +1 (total 104), got %s', v_total);

  -- AC-4: an invalid slug is rejected. Pinned to the errcode the RPC itself
  -- raises (22023, 00055) rather than `when others`, which would be satisfied
  -- by ANY failure — a renamed function, a revoked grant, a typo in this call —
  -- and so would prove nothing about slug validation.
  begin
    perform lorekit_blog_like('Not A Slug!', 1);
  exception when sqlstate '22023' then
    v_raised := true;
  end;
  assert v_raised, 'blog likes AC-4: an invalid slug shape must raise 22023';

  reset role;
end;
$$;

-- AC-5: the anonymous role can both write and read.
do $$
declare
  v_total bigint;
  v_read  bigint;
begin
  set local role anon;

  select lorekit_blog_like('anon-post', 3) into v_total;
  assert v_total = 3, format('blog likes AC-5: anon write must total 3, got %s', v_total);

  select likes into v_read from blog_post_likes where slug = 'anon-post';
  assert v_read = 3, format('blog likes AC-5: anon read under the public policy must see 3, got %s', v_read);

  reset role;
end;
$$;

-- AC-6: writes really do go ONLY through lorekit_blog_like. The migration
-- header rests its whole security argument on there being no insert/update RLS
-- policy, so that has to be executable, not prose.
--
-- Deliberately mechanism-agnostic. A missing table grant and a missing RLS
-- policy BOTH surface as insufficient_privilege (42501) on the INSERT, and an
-- UPDATE that is granted but unpolicied matches zero rows with no error at all
-- — so the UPDATE leg tolerates the exception and asserts the INVARIANT (the
-- total did not move) instead of pinning one of the two outcomes. Note also
-- that a plpgsql exception block is a subtransaction: an aborted one rolls back
-- its own `set local role`, which is why each leg re-establishes the role.
do $$
declare
  v_denied boolean := false;
  v_total  bigint;
begin
  -- Seed a row for the UPDATE leg through the sanctioned path.
  set local role service_role;
  perform lorekit_blog_like('direct-write-probe', 5);
  reset role;

  -- A direct INSERT as the anonymous blog visitor must be refused.
  begin
    set local role anon;
    insert into blog_post_likes (slug, likes) values ('bypass-attempt', 999);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  assert v_denied,
    'blog likes AC-6: a direct anon INSERT must be denied — writes go only through lorekit_blog_like';

  -- A direct UPDATE as anon must not be able to move a total.
  begin
    set local role anon;
    update blog_post_likes set likes = 100000 where slug = 'direct-write-probe';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  select likes into v_total from blog_post_likes where slug = 'direct-write-probe';
  assert v_total = 5,
    format('blog likes AC-6: a direct anon UPDATE must not change the total, got %s', v_total);

  -- And the refused INSERT left no junk row behind.
  select count(*) into v_total from blog_post_likes where slug = 'bypass-attempt';
  assert v_total = 0,
    format('blog likes AC-6: the refused INSERT must leave no row, got %s', v_total);
end;
$$;

-- ── 74. usage_events.scope — per-scope read attribution (00058) ─────────────
-- Reads already carried `scope_type` (the low-cardinality family: repo /
-- branch / …), which cannot answer "how much did I read from
-- repo::mthines/lorekit". 00058 adds the EXACT scope and regroups
-- lorekit_read_activity one row per (bucket, scope), mirroring
-- lorekit_memory_activity (00051), plus an optional exact-match p_scope filter.
--
-- AC-1: the column is nullable with a length CHECK backstop and a partial
--       index; a NULL-scope row inserts fine and a 201-char one is refused.
-- AC-2: the series is GROUPED — two scopes in one bucket come back as two rows
--       with their own counts, not one merged total.
-- AC-3: p_scope restricts to one exact scope, and the filtered buckets SUM to
--       that scope's headline. This is why no companion total RPC exists.
-- AC-4: a NULL-scope read is still COUNTED in the unfiltered series — reads
--       whose scope could not be resolved are unattributed, never dropped —
--       and is NOT swept into a named-scope filter.
-- AC-5: the 00054 dashboard exclusion survives the regrouping, per scope.
-- AC-6: the writer persists p_scope, and a call that omits it (every caller
--       written before this migration) still succeeds with scope NULL.
--
-- Dated 2026-06 so it cannot collide with §71's 2026-04 fixture, §72's 2026-05
-- one, or the usage-statistics section's all-time totals.
insert into usage_events (user_id, plan_name, tool_name, scope_type, auth_type, outcome, duration_ms, result_count, client, scope, created_at) values
  -- Two DIFFERENT scopes inside the SAME hour, which is what makes AC-2
  -- discriminating: an ungrouped RPC returns one row of 12 here, not two.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',   'repo',   'api_key', 'ok', 10,  8, 'mcp', 'repo::mthines/lorekit',  timestamptz '2026-06-01 01:10:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.search', 'repo',   'api_key', 'ok', 10,  4, 'mcp', 'repo::mthines/gw-tools', timestamptz '2026-06-01 01:20:00+00'),
  -- A second event for the FIRST scope in a LATER bucket: p_scope must sum
  -- across buckets, so a filter that only ever returns one row would fail AC-3.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.read',   'repo',   'api_key', 'ok', 10,  5, 'mcp', 'repo::mthines/lorekit',  timestamptz '2026-06-01 03:00:00+00'),
  -- Unattributable: a scope the server could not resolve (body-carried, or
  -- ungrammatical and coerced to null by safeValidateScope).
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',   'global', 'api_key', 'ok', 10,  3, 'mcp', null,                     timestamptz '2026-06-01 01:30:00+00'),
  -- The dashboard drawing the chart, under a real scope — must stay excluded.
  ('00000000-0000-0000-0000-0000000000a1', 'free', 'memory.list',   'repo',   'jwt',     'ok', 10, 99, 'dashboard', 'repo::mthines/lorekit', timestamptz '2026-06-01 01:40:00+00');

do $$
declare
  v_rows    int;
  v_count   bigint;
  v_scope   text;
  v_total   bigint;
  v_id      uuid;
  v_raised  boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"service_role"}', true);

  -- ── AC-1: the column, the CHECK and the index are real schema, not prose ──
  select count(*) into v_rows
    from information_schema.columns
   where table_name = 'usage_events' and column_name = 'scope' and is_nullable = 'YES';
  assert v_rows = 1, 'usage scope AC-1: usage_events.scope must exist and be nullable';

  select count(*) into v_rows
    from pg_indexes
   where tablename = 'usage_events' and indexname = 'usage_events_user_scope_created_idx';
  assert v_rows = 1, 'usage scope AC-1: the partial (user_id, scope, created_at desc) index must exist';

  -- The CHECK is a BACKSTOP against an unbounded value inflating analytics
  -- cardinality — the app-side validator is the primary gate, but a direct
  -- insert must not be able to bypass the storage guarantee. 200 is the
  -- boundary, so 201 is the discriminating length.
  begin
    insert into usage_events (user_id, tool_name, auth_type, outcome, scope)
      values ('00000000-0000-0000-0000-0000000000a1', 'memory.list', 'jwt', 'ok', repeat('x', 201));
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, 'usage scope AC-1: a 201-char scope must violate the CHECK';

  -- ...and exactly 200 is still admitted, so the CHECK is a bound, not a ban.
  insert into usage_events (user_id, tool_name, auth_type, outcome, scope)
    values ('00000000-0000-0000-0000-0000000000a1', 'memory.write', 'jwt', 'ok', repeat('x', 200));

  -- AC-1: the CHECK's blast radius, executed. The writer swallows every error
  -- (`when others → return null`), so an over-long scope reaching the RPC does
  -- NOT lose the scope — it loses the ENTIRE usage event, silently. That is why
  -- `safeValidateScope` bounds length client-side at USAGE_SCOPE_MAX. Pinning
  -- the consequence here means a future "simplification" that drops the
  -- client-side bound fails a test instead of quietly deleting analytics rows.
  select lorekit_record_usage_event(
    p_user_id => '00000000-0000-0000-0000-0000000000a1',
    p_tool_name => 'memory.list',
    p_auth_type => 'jwt',
    p_outcome => 'ok',
    p_result_count => 1,
    p_scope => repeat('x', 201)) into v_id;
  assert v_id is null,
    'usage scope AC-1: an over-long scope must take the WHOLE event down (writer swallows) — '
    || 'this is precisely why safeValidateScope bounds length before the write';

  -- ...and the same call with the scope already dropped to NULL — what
  -- safeValidateScope actually hands the writer — DOES land. The event survives;
  -- only the dimension is lost. This is the pair that makes the bound's value
  -- visible rather than asserted in prose.
  select lorekit_record_usage_event(
    p_user_id => '00000000-0000-0000-0000-0000000000a1',
    p_tool_name => 'memory.list',
    p_auth_type => 'jwt',
    p_outcome => 'ok',
    p_result_count => 1,
    p_scope => null) into v_id;
  assert v_id is not null,
    'usage scope AC-1: dropping the scope to NULL must preserve the event';

  -- ── AC-2 + AC-4 + AC-5: the grouped shape ─────────────────────────────────
  -- The 01:00 hour holds three counted reads under three distinct scope values
  -- (lorekit 8, gw-tools 4, NULL 3) plus the dashboard's 99, which is excluded.
  select count(*) into v_rows
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 01:00:00+00', timestamptz '2026-06-01 02:00:00+00');
  assert v_rows = 3,
    format('usage scope AC-2/AC-4: the 01:00 hour must yield 3 (bucket,scope) rows, got %s', v_rows);

  -- AC-2: each scope keeps its OWN count. A merged 12 here would mean the
  -- grouping is cosmetic.
  select count into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 01:00:00+00', timestamptz '2026-06-01 02:00:00+00')
   where scope = 'repo::mthines/lorekit';
  assert v_count = 8,
    format('usage scope AC-2: repo::mthines/lorekit must read 8 in the 01:00 hour, got %s', v_count);

  select count into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 01:00:00+00', timestamptz '2026-06-01 02:00:00+00')
   where scope = 'repo::mthines/gw-tools';
  assert v_count = 4,
    format('usage scope AC-2: repo::mthines/gw-tools must read 4 in the 01:00 hour, got %s', v_count);

  -- AC-4: the unattributed read is present as a `scope is null` row and still
  -- counted. Dropping it would silently shrink the account total, which is the
  -- exact failure `is distinct from` guards against on the client column.
  select count into v_count
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 01:00:00+00', timestamptz '2026-06-01 02:00:00+00')
   where scope is null;
  assert v_count = 3,
    format('usage scope AC-4: the NULL-scope read must be counted as 3, got %s', v_count);

  -- AC-5: the dashboard's 99 is nowhere in the hour — under ANY scope. The
  -- whole-hour total is 8 + 4 + 3 = 15; 114 would mean the regrouping lost the
  -- 00054 exclusion.
  select coalesce(sum(count), 0) into v_total
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 01:00:00+00', timestamptz '2026-06-01 02:00:00+00');
  assert v_total = 15,
    format('usage scope AC-5: the 01:00 hour must total 15 with the dashboard excluded, got %s', v_total);

  -- ── AC-3: p_scope is an exact filter whose buckets SUM to the headline ────
  -- lorekit is read in two different buckets (8 at 01:00, 5 at 03:00). Two rows
  -- back, summing to 13 — the per-scope headline the Explorer's stats card
  -- shows above these very bars.
  select count(*), coalesce(sum(count), 0) into v_rows, v_total
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 00:00:00+00', timestamptz '2026-06-02 00:00:00+00',
      'repo::mthines/lorekit');
  assert v_rows = 2,
    format('usage scope AC-3: the filter must span buckets, expected 2 rows, got %s', v_rows);
  assert v_total = 13,
    format('usage scope AC-3: repo::mthines/lorekit must sum to 13, got %s', v_total);

  -- AC-3: and it is EXACT — the other scope is gone entirely, not merely
  -- ordered later.
  select count(*) into v_rows
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'hour',
      timestamptz '2026-06-01 00:00:00+00', timestamptz '2026-06-02 00:00:00+00',
      'repo::mthines/lorekit')
   where scope is distinct from 'repo::mthines/lorekit';
  assert v_rows = 0,
    format('usage scope AC-3: a filtered call must return only that scope, got %s foreign rows', v_rows);

  -- AC-3 + AC-4: filtering by a named scope must NOT sweep in the NULL-scope
  -- remainder. `=` and not `is not distinct from` — a caller asking for a named
  -- scope wants events attributed to it. This is why the per-scope total (13)
  -- is legitimately SMALLER than the day's account total, and the UI says so.
  select coalesce(sum(count), 0) into v_total
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-06-01 00:00:00+00', timestamptz '2026-06-02 00:00:00+00');
  assert v_total = 20,
    format('usage scope AC-4: the unfiltered day must total 20 (13 + 4 + 3), got %s', v_total);

  -- A filter naming a scope with no events is empty, not everything — the
  -- discriminating case for a predicate accidentally written as always-true.
  select count(*) into v_rows
    from lorekit_read_activity(
      '00000000-0000-0000-0000-0000000000a1', 'day',
      timestamptz '2026-06-01 00:00:00+00', timestamptz '2026-06-02 00:00:00+00',
      'repo::mthines/does-not-exist');
  assert v_rows = 0,
    format('usage scope AC-3: an unmatched scope filter must return no rows, got %s', v_rows);

  -- ── AC-6: the writer ──────────────────────────────────────────────────────
  -- The new trailing parameter is persisted.
  select lorekit_record_usage_event(
    p_user_id => '00000000-0000-0000-0000-0000000000a1',
    p_plan_name => 'free',
    p_tool_name => 'memory.list',
    p_scope_type => 'repo',
    p_auth_type => 'api_key',
    p_outcome => 'ok',
    p_result_count => 2,
    p_scope => 'repo::mthines/lorekit') into v_id;
  assert v_id is not null, 'usage scope AC-6: the writer must return the inserted id';
  select scope into v_scope from usage_events where id = v_id;
  assert v_scope = 'repo::mthines/lorekit',
    format('usage scope AC-6: p_scope must be persisted, got %s', v_scope);

  -- ...and a call that OMITS it — every caller written before 00058, including
  -- the 14-argument positional form 00056 left behind — still succeeds, with
  -- scope NULL. A stale DROP target would instead make this call ambiguous.
  select lorekit_record_usage_event(
    '00000000-0000-0000-0000-0000000000a1', null, 'free',
    'memory.list', 'repo', 'jwt', 'ok', 5, null, 3, null, 'cli', null, null) into v_id;
  assert v_id is not null, 'usage scope AC-6: the pre-00058 14-arg call must still resolve';
  select scope into v_scope from usage_events where id = v_id;
  assert v_scope is null,
    format('usage scope AC-6: a call omitting p_scope must leave scope NULL, got %s', v_scope);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- AC-1: the grant surface follows 00047's hardening — the regrouped reader is
-- reachable by an authenticated user and by service_role, and NEVER by anon.
-- The signature changed, so the revoke/grant had to be re-issued against the
-- NEW one; a stale grant would leave anon holding EXECUTE on a function that
-- reads the whole usage ledger.
do $$
declare
  -- 00069 appended `p_key_scopes text[]`, so the live signature is the 6-arg
  -- one. Asserted against the CURRENT signature rather than 00058's: a
  -- privilege probe against a signature that no longer exists errors out, and
  -- the overload count below is what pins that only one form is live.
  v_sig text := 'lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[])';
  v_overloads int;
begin
  assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
    'usage scope: anon must NOT hold execute on the regrouped lorekit_read_activity';
  assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    'usage scope: authenticated must hold execute on the regrouped lorekit_read_activity';
  assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
    'usage scope: service_role must hold execute on the regrouped lorekit_read_activity';

  -- The old 4-argument signature must be GONE, not merely shadowed. A missed
  -- DROP leaves both overloads live, and PostgREST's named-argument resolution
  -- would then be free to pick the ungrouped one — the endpoint would keep
  -- working while silently returning the pre-00058 shape.
  select count(*) into v_overloads
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'lorekit_read_activity';
  assert v_overloads = 1,
    format('usage scope: exactly one lorekit_read_activity overload must exist, found %s', v_overloads);

  -- Same for the writer: 00056's 14-argument form must have been replaced, not
  -- joined by a 15-argument sibling.
  select count(*) into v_overloads
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'lorekit_record_usage_event';
  assert v_overloads = 1,
    format('usage scope: exactly one lorekit_record_usage_event overload must exist, found %s', v_overloads);
end;
$$;

-- AC-6 (deferral, R10): purge_expired_memories is deliberately UNTOUCHED by
-- 00058 — its `memory.expired` event is per-USER and spans every scope that
-- user owns, so there is no single scope to attribute it to. Asserted, not just
-- documented, so "we'll do it later" cannot quietly become "we did it wrong":
-- the expiry event must still record a NULL scope.
do $$
declare v_scopes int;
begin
  set local role service_role;
  select count(*) into v_scopes
    from usage_events
   where tool_name = 'memory.expired' and scope is not null;
  assert v_scopes = 0,
    format('usage scope R10: memory.expired must remain scope-unattributed, found %s attributed', v_scopes);
  reset role;
end;
$$;

-- ── 75. "expiring soon" — the (now, bound] list predicate (PR-2) ────────────
-- Backs `GET /memories?expiring_within_days=N`, the Explorer's "expiring soon"
-- Status view. NO migration: the predicate is applied by the list handler and
-- range-scans `memories_expires_at_idx` (00030), the partial index on
-- `expires_at is not null`.
--
-- SCOPE OF THIS SECTION, stated plainly so it is not read as more than it is:
-- it asserts the PREDICATE the handler emits, over real rows, at the
-- boundaries — the part where the semantics can be wrong. It does NOT exercise
-- the handler's PostgREST translation; that is the live smoke test's job
-- (`memories-api.integration.spec.ts`). The two are complementary: this one can
-- seed a row expiring in exactly N days and an already-expired one, which a
-- live suite cannot do without waiting.
--
-- AC-1: rows expiring inside the window are returned.
-- AC-2: an ALREADY-EXPIRED row is excluded — the lower bound is exclusive, and
--       this is why the handler re-states it instead of leaning on the live
--       branch (which `archived=true` does not apply).
-- AC-3: a row with NO TTL is excluded, and with no `expires_at is not null`
--       clause: the comparisons drop it on their own, which is the claim
--       `expiring-window.ts` makes and the one most likely to be "simplified".
-- AC-4: the boundaries are (exclusive, inclusive] — a row expiring exactly at
--       `now` is out; one expiring exactly at the bound is in.
-- AC-5: the partial index that makes this affordable actually exists.

-- Every row is positioned relative to a FIXED instant, so "already expired" and
-- "expires in exactly 7 days" are exact rather than racing the suite's runtime.
insert into memories (user_id, scope, key, value, expires_at) values
  -- In-window: comfortably inside a 7-day horizon.
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-in-3d',   'v', timestamptz '2026-06-04 12:00:00+00'),
  -- In-window, at the far edge: expires at EXACTLY now + 7 days. The inclusive
  -- upper bound is the whole reason this row is expected back.
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-at-edge', 'v', timestamptz '2026-06-08 12:00:00+00'),
  -- Out of window: real and live, but further out than the horizon asked for.
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-in-30d',  'v', timestamptz '2026-07-01 12:00:00+00'),
  -- Already expired: still on the table (the purge is nightly), and must never
  -- surface in a view whose whole promise is "act before these go".
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-past',    'v', timestamptz '2026-05-01 12:00:00+00'),
  -- Exactly at `now`: expired by one instant. The discriminating row for an
  -- accidentally-inclusive lower bound.
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-at-now',  'v', timestamptz '2026-06-01 12:00:00+00'),
  -- No TTL at all: permanent lore, never "expiring".
  ('00000000-0000-0000-0000-0000000000a1', 'global', 'exp-none',    'v', null);

do $$
declare
  -- The frozen clock and the 7-day horizon `expiringWindow(7, now)` derives
  -- from it. Two literals rather than an expression, so this test cannot
  -- reproduce an arithmetic bug in the code it is checking.
  v_now   constant timestamptz := timestamptz '2026-06-01 12:00:00+00';
  v_bound constant timestamptz := timestamptz '2026-06-08 12:00:00+00';
  v_keys  text[];
  v_rows  int;
begin
  set local role service_role;

  -- The predicate EXACTLY as the handler emits it: two comparisons, no
  -- `is not null`, lower exclusive, upper inclusive.
  select array_agg(key order by key) into v_keys
    from memories
   where user_id = '00000000-0000-0000-0000-0000000000a1'
     and archived_at is null
     and key like 'exp-%'
     and expires_at >  v_now
     and expires_at <= v_bound;

  -- AC-1 + AC-2 + AC-3 + AC-4 in one discriminating assertion. Each wrong
  -- boundary produces a DIFFERENT wrong array, so a failure names the bug:
  --   + exp-at-now  → the lower bound was made inclusive
  --   - exp-at-edge → the upper bound was made exclusive
  --   + exp-past    → the lower bound is missing entirely
  --   + exp-in-30d  → the upper bound is missing entirely
  --   + exp-none    → NULL is leaking through (a coalesce, or a `not (…)`)
  assert v_keys = array['exp-at-edge', 'exp-in-3d'],
    format('expiring AC-1..4: expected exactly {exp-at-edge, exp-in-3d}, got %s', v_keys);

  -- AC-3, isolated. The no-TTL row is the one a future "simplification" would
  -- re-admit by rewriting the pair as a NOT of the live predicate, so it gets
  -- its own assertion rather than only living inside the array above.
  select count(*) into v_rows
    from memories
   where key = 'exp-none'
     and expires_at >  v_now
     and expires_at <= v_bound;
  assert v_rows = 0,
    format('expiring AC-3: a memory with no TTL must never be "expiring soon", got %s rows', v_rows);

  -- AC-2, isolated, with the reason attached: the expired row is STILL PRESENT
  -- in the table (purging is a nightly job, not a read-path delete), so its
  -- absence from the result is the predicate's doing and not the fixture's.
  select count(*) into v_rows from memories where key = 'exp-past';
  assert v_rows = 1,
    'expiring AC-2: the fixture must still hold the expired row — otherwise its exclusion proves nothing';

  reset role;
end;
$$;

-- AC-5: the index this predicate relies on exists and is the PARTIAL one.
-- Asserted, not assumed: the plan for `expires_at > x and expires_at <= y` is a
-- range scan over exactly the `expires_at is not null` subset, which is why
-- PR-2 adds no index of its own. If 00030's index were dropped or made total,
-- this filter would quietly become a seq scan on the largest table.
do $$
declare v_where text;
begin
  select pg_get_expr(i.indpred, i.indrelid) into v_where
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where c.relname = 'memories_expires_at_idx';

  assert v_where is not null,
    'expiring AC-5: memories_expires_at_idx (00030) must exist — the expiring filter has no index of its own';
  assert v_where like '%expires_at IS NOT NULL%',
    format('expiring AC-5: memories_expires_at_idx must stay PARTIAL on expires_at is not null, got %s', v_where);
end;
$$;

-- ── 76. memories.seen_count — recurrence counted by the writer (00059) ──────
-- The counter LoreKit's own skill guidance has always gated promotion on
-- (`seen_count >= 3`) never existed as a column; it lived as hand-written text
-- in a lesson body's `meta:` comment, so nothing incremented it and nothing
-- could read it. 00059 makes it real and puts the increment in the upsert,
-- which is where a recurrence actually happens.
-- AC-1: a first write inserts with seen_count = 1.
-- AC-2: a second write to the same (tenant, scope, key) increments to 2 and
--       updates the existing row instead of inserting a second one. This says
--       nothing about WHICH row the increment reads: `memories.seen_count + 1`
--       and `excluded.seen_count + 1` both yield 2 on the second write.
-- AC-3: the count keeps climbing, and the row is still the SAME row. This is
--       the assertion that discriminates the two: `excluded` is the row the
--       INSERT proposed and always carries the literal 1, so an `excluded`-based
--       increment would pin the count at 2 while four writes must leave 4.
-- AC-4: the OTHER two conflict branches increment too — the service-role
--       branch (p_user_id null) and the org branch (p_org_slug set). AC-1…AC-3
--       only ever write through the personal branch, and 00059 edited all
--       three, so "all three branches" has to be exercised, not asserted.
-- AC-5: reviving an ARCHIVED key is NOT a recurrence. The conflict predicates
--       are partial on `archived_at is null`, so this inserts a fresh row that
--       starts back at 1 — the lesson was retired and is being learned again.
-- AC-6: the CHECK is a real backstop — a direct write of 0 is rejected, so a
--       corrupt value fails loudly instead of silently sinking a lesson's
--       salience in whatever ranks on this column later.
do $$
declare
  v_uid constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_id1    uuid;
  v_id2    uuid;
  v_seen   integer;
  v_raised boolean := false;
begin
  -- AC-1 — first sighting.
  select id into v_id1 from memory_write(v_uid, 'global', 'seen-count-key', 'v1');
  select seen_count into v_seen from memories where id = v_id1;
  assert v_seen = 1,
    format('seen_count AC-1: a first write must insert seen_count = 1, got %s', v_seen);

  -- AC-2 — the recurrence.
  select id into v_id2 from memory_write(v_uid, 'global', 'seen-count-key', 'v2');
  select seen_count into v_seen from memories where id = v_id2;
  assert v_id2 = v_id1, 'seen_count AC-2: the recurrence must update the existing row';
  assert v_seen = 2,
    format('seen_count AC-2: the second write must increment to 2, got %s', v_seen);

  -- AC-3 — it keeps counting, on the same row.
  perform memory_write(v_uid, 'global', 'seen-count-key', 'v3');
  perform memory_write(v_uid, 'global', 'seen-count-key', 'v4');
  select seen_count into v_seen from memories where id = v_id1;
  assert v_seen = 4,
    format('seen_count AC-3: four writes must leave seen_count = 4, got %s '
           '(a value pinned at 2 means the increment reads excluded.seen_count)', v_seen);
  assert (select count(*) from memories where scope = 'global' and key = 'seen-count-key') = 1,
    'seen_count AC-3: four writes must leave exactly one row';

  -- AC-4 — the service-role branch counts too (p_user_id null).
  select id into v_id1 from memory_write(null, 'global', 'seen-count-service-key', 'v1');
  perform memory_write(null, 'global', 'seen-count-service-key', 'v2');
  select seen_count into v_seen from memories where id = v_id1;
  assert v_seen = 2,
    format('seen_count AC-4: the service branch must increment as well, got %s', v_seen);

  -- AC-4 — and so does the org branch (p_org_slug; a1 owns test-org / f1).
  -- The org insert branch writes user_id null and arbitrates on
  -- (org_id, scope, key), so it is a genuinely different conflict target from
  -- both the personal and the service branch.
  select id into v_id1 from memory_write(v_uid, 'global', 'seen-count-org-key', 'v1',
                                         '{}'::text[], null, null, null, 'test-org');
  perform memory_write(v_uid, 'global', 'seen-count-org-key', 'v2',
                       '{}'::text[], null, null, null, 'test-org');
  select seen_count into v_seen from memories where id = v_id1;
  assert v_seen = 2,
    format('seen_count AC-4: the org branch must increment as well, got %s', v_seen);
  assert (select org_id from memories where id = v_id1)
           = '00000000-0000-0000-0000-0000000000f1',
    'seen_count AC-4: the org write must land on an org-owned row, not a personal one';
  assert (select count(*) from memories
           where scope = 'global' and key = 'seen-count-org-key') = 1,
    'seen_count AC-4: the org recurrence must update the row, not insert a second';

  -- AC-5 — reviving an archived key starts over.
  select id into v_id1 from memory_write(v_uid, 'global', 'seen-count-archived-key', 'v1');
  perform memory_write(v_uid, 'global', 'seen-count-archived-key', 'v2');
  select seen_count into v_seen from memories where id = v_id1;
  assert v_seen = 2, format('seen_count AC-5: precondition — expected 2, got %s', v_seen);

  update memories set archived_at = now() where id = v_id1;
  select id into v_id2 from memory_write(v_uid, 'global', 'seen-count-archived-key', 'v3');
  select seen_count into v_seen from memories where id = v_id2;
  assert v_id2 <> v_id1,
    'seen_count AC-5: writing an archived key must insert a NEW row, not revive the archived one';
  assert v_seen = 1,
    format('seen_count AC-5: the revived lesson must start back at 1, got %s', v_seen);

  -- AC-6 — the CHECK backstop.
  begin
    update memories set seen_count = 0 where id = v_id2;
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised,
    'seen_count AC-6: memories_seen_count_positive must reject a non-positive count';
end;
$$;

-- ── 75. The FTS candidate selection GET /memories/relevant ranks over (00001) ─
-- `GET /memories/relevant` fetches candidates with
-- `textSearch('fts', q, { type: 'websearch', config: 'english' })` and then
-- ranks them in TypeScript. The RANKING is unit-tested (and held to the CLI's
-- copy by `lesson-rank-parity.spec.ts`), but the SELECTION is pure SQL and had
-- NO coverage anywhere in this file: the `fts` generated column has existed
-- since 00001 and nothing asserted what it matches. A change to its expression
-- or its text-search config would silently change which lessons are reachable —
-- through this route and through `POST /memories/search`, which uses the same
-- column.
-- AC-1: a term in the VALUE matches, and AC-5 rides along with it.
-- AC-2: a term in the KEY matches — `fts` is generated over `key || value`, so
--       a lesson whose body never repeats its own title is still findable.
-- AC-3: English STEMMING is on: `migrations` finds `migration`. That is what
--       makes the endpoint usable with a natural-language query instead of an
--       exact keyword.
-- AC-4: a quoted phrase matches as a phrase, and websearch negation excludes.
-- AC-5: the ACTIVE partition — an archived row and an expired row are not
--       candidates, matching the handler's `archived_at is null` +
--       `expires_at is null or expires_at > now()` predicate.
-- AC-6: a term present in nothing matches nothing. Without this, every other
--       assertion here would still pass if the predicate were a no-op that let
--       recency rank the tenant's entire store.
do $$
declare
  v_uid  constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_hits integer;
begin
  perform memory_write(v_uid, 'global', 'fts-migration-order',
    'Always add the column before the backfill runs.');
  perform memory_write(v_uid, 'global', 'fts-flaky-retry',
    'The retry wrapper hides a real race in the fixture.');
  perform memory_write(v_uid, 'global', 'fts-archived-one',
    'An archived lesson about backfill that must not be a candidate.');
  perform memory_write(v_uid, 'global', 'fts-expired-one',
    'An expired lesson about backfill that must not be a candidate.');

  update memories set archived_at = now()
    where user_id = v_uid and key = 'fts-archived-one';
  update memories set expires_at = now() - interval '1 day'
    where user_id = v_uid and key = 'fts-expired-one';

  -- AC-1 + AC-5 — a term in the value, and only the ACTIVE row carrying it.
  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', 'backfill');
  assert v_hits = 1,
    format('relevant AC-1/AC-5: "backfill" must match exactly the one ACTIVE lesson, got %s '
           '(three rows contain the word; the archived and expired ones are not candidates)', v_hits);

  -- AC-2 — a term present only in the KEY.
  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', 'flaky');
  assert v_hits = 1,
    format('relevant AC-2: a term present only in the key must match — fts is generated '
           'over key || value — got %s', v_hits);

  -- AC-3 — English stemming.
  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', 'migrations');
  assert v_hits = 1,
    format('relevant AC-3: the english config must stem "migrations" onto "migration", got %s '
           '(a `simple` config would return 0 and make natural-language queries useless)', v_hits);

  -- AC-4 — phrase and negation, the two websearch operators a caller can type.
  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', '"real race"');
  assert v_hits = 1,
    format('relevant AC-4: a quoted phrase must match as a phrase, got %s', v_hits);

  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', 'lesson -backfill');
  assert v_hits = 0,
    format('relevant AC-4: websearch negation must exclude the negated term, got %s', v_hits);

  -- AC-6 — anti-vacuity for every assertion above.
  select count(*) into v_hits from memories
   where user_id = v_uid and key like 'fts-%'
     and archived_at is null and (expires_at is null or expires_at > now())
     and fts @@ websearch_to_tsquery('english', 'kubernetes');
  assert v_hits = 0,
    format('relevant AC-6: a term present in no lesson must match nothing, got %s', v_hits);
end;
$$;

-- ── 77. memories.embedding — the dormant semantic column (00060) ────────────
-- 00060 lands the schema for semantic search with NOTHING reading or writing
-- it. These assertions are therefore mostly about ABSENCE of effect: the point
-- of a dormant migration is that you can prove it changed no behaviour, and a
-- structural claim in a comment proves nothing.
-- AC-1: the extension, both columns and both indexes are real schema.
-- AC-2: the column is NULLABLE with NO DEFAULT. Null means "not embedded yet",
--       which is the state every existing row is in and the state the backfill
--       will query for; a default would make "never embedded" indistinguishable
--       from "embedded as zeroes".
-- AC-3: every pre-existing row reads null — the migration backfilled nothing.
-- AC-4: `memory_write` is UNAFFECTED. It takes no embedding parameter and a
--       write leaves the column null, so the whole existing write path is
--       untouched by a column it does not know about.
-- AC-5: the pairing CHECK holds in both directions. A vector without a model is
--       unattributable and a model without a vector is a lie about what the row
--       holds; both are silent failures, so they are refused at the storage
--       layer rather than trusted to a writer that does not exist yet.
-- AC-6: the model column's length backstop bounds an unbounded free-text value.
-- AC-7: a vector of the WRONG WIDTH is refused. This is what pins the 1536
--       decision to the schema — pgvector's HNSW index rejects more than 2000
--       dimensions, so a later "let's just use the 3072 model" would otherwise
--       fail at index-build time in a deploy rather than here.
do $$
declare
  v_uid   constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_rows  int;
  v_id    uuid;
  v_null  int;
  v_raised boolean;
  v_msg   text;
  -- A syntactically valid 1536-dimension vector, built rather than typed.
  v_vec   constant text := '[' || array_to_string(array_fill(0.001::real, array[1536]), ',') || ']';
begin
  -- AC-1 — the extension and the schema it made possible.
  select count(*) into v_rows from pg_extension where extname = 'vector';
  assert v_rows = 1, 'embeddings AC-1: the vector extension must be enabled';

  select count(*) into v_rows
    from information_schema.columns
   where table_name = 'memories' and column_name = 'embedding';
  assert v_rows = 1, 'embeddings AC-1: memories.embedding must exist';

  select count(*) into v_rows
    from information_schema.columns
   where table_name = 'memories' and column_name = 'embedding_model';
  assert v_rows = 1, 'embeddings AC-1: memories.embedding_model must exist';

  select count(*) into v_rows
    from pg_indexes
   where tablename = 'memories' and indexname = 'memories_embedding_hnsw_idx';
  assert v_rows = 1, 'embeddings AC-1: the HNSW ANN index must exist';

  select count(*) into v_rows
    from pg_indexes
   where tablename = 'memories' and indexname = 'memories_embedding_pending_idx';
  assert v_rows = 1,
    'embeddings AC-1: the backfill coverage index must exist — without it a '
    'resumable backfill scans the whole table on every batch';

  -- The index must be HNSW, not IVFFlat. Built on an empty table IVFFlat
  -- produces meaningless centroids and has to be dropped and rebuilt once data
  -- lands, which is a second migration on a table that is large by then.
  select count(*) into v_rows
    from pg_class c
    join pg_am am on am.oid = c.relam
   where c.relname = 'memories_embedding_hnsw_idx' and am.amname = 'hnsw';
  assert v_rows = 1, 'embeddings AC-1: the ANN index must use HNSW, not IVFFlat';

  -- AC-2 — nullable, and no default.
  select count(*) into v_rows
    from information_schema.columns
   where table_name = 'memories' and column_name = 'embedding'
     and is_nullable = 'YES' and column_default is null;
  assert v_rows = 1, 'embeddings AC-2: embedding must be nullable with no default';

  -- AC-3 — the migration embedded nothing. Anti-vacuity first: there must be
  -- rows to be null, or this assertion is about the empty set.
  select count(*) into v_rows from memories;
  assert v_rows > 0, 'embeddings AC-3: precondition — earlier sections must have written rows';
  select count(*) into v_null from memories where embedding is null;
  assert v_null = v_rows,
    format('embeddings AC-3: every pre-existing row must read null, got %s of %s', v_null, v_rows);

  -- AC-4 — the existing write path is untouched by a column it does not know.
  select id into v_id from memory_write(v_uid, 'global', 'embedding-dormant-key', 'v');
  select count(*) into v_rows
    from memories where id = v_id and embedding is null and embedding_model is null;
  assert v_rows = 1, 'embeddings AC-4: memory_write must leave both columns null';

  -- AC-5 — the pairing CHECK, both directions.
  v_raised := false;
  begin
    update memories set embedding = v_vec::vector where id = v_id;
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, 'embeddings AC-5: a vector with no model must be refused';

  v_raised := false;
  begin
    update memories set embedding_model = 'text-embedding-3-small' where id = v_id;
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, 'embeddings AC-5: a model with no vector must be refused';

  -- ...and the pair together is admitted, so the CHECK is a pairing rule and
  -- not a ban on ever using the columns.
  update memories
     set embedding = v_vec::vector, embedding_model = 'text-embedding-3-small'
   where id = v_id;
  select count(*) into v_rows from memories where id = v_id and embedding is not null;
  assert v_rows = 1, 'embeddings AC-5: a vector WITH its model must be admitted';

  -- AC-6 — the model length backstop.
  v_raised := false;
  begin
    update memories set embedding_model = repeat('x', 129) where id = v_id;
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, 'embeddings AC-6: a 129-char embedding_model must violate the CHECK';

  -- AC-7 — the width is pinned by the type, so a wrong-dimension vector cannot
  -- be stored at all. The handler is `data_exception` (SQLSTATE class 22) and
  -- not `others`: pgvector's typmod coercion raises ERRCODE_DATA_EXCEPTION with
  -- "expected 1536 dimensions, not 3", so `others` would let ANY failure —
  -- including one unrelated to width — satisfy the assertion. The message check
  -- is what keeps the assertion pinned to the dimension mismatch it claims to
  -- prove rather than to "some class-22 error happened". It carries the literal
  -- `1536` on purpose: matching only `%dimensions%` would prove *a* width
  -- complaint and would keep passing if the column were silently redefined to
  -- some other width, which is the one redefinition this AC exists to catch.
  v_raised := false;
  v_msg    := null;
  begin
    update memories set embedding = '[0.1,0.2,0.3]'::vector where id = v_id;
  exception when data_exception then
    v_raised := true;
    v_msg    := sqlerrm;
  end;
  assert v_raised, 'embeddings AC-7: a 3-dimension vector must be refused by the 1536-wide column';
  assert v_msg like '%1536 dimensions%',
    format('embeddings AC-7: the refusal must name the 1536-wide column, got %L', v_msg);
end;
$$;

-- ── 78. memories keyset-covering index for the list seek (00061) ────────────
-- The audit_log precedent (00012, asserted in section 11) applied to the
-- hottest read path in the product: the list query orders by
-- (updated_at desc, id desc) and seeks on the same pair, so the index must
-- carry the id column or the tiebreaker becomes a heap recheck. 00033's
-- (scope, updated_at desc) index predates keyset pagination entirely.
do $$
declare
  v_keyset_idx boolean;
  v_partial    boolean;
  v_columns    boolean;
begin
  select exists (
    select 1 from pg_indexes
    where tablename = 'memories' and indexname = 'memories_scope_updated_at_id_idx'
  ) into v_keyset_idx;
  assert v_keyset_idx,
    'memories keyset: (scope, updated_at desc, id desc) covering index must exist';

  -- The partial predicate is the half that makes it describe the same row
  -- population as 00033's index; an index over ALL rows would still satisfy the
  -- existence check above while quietly covering archived lore too.
  select exists (
    select 1 from pg_indexes
    where tablename = 'memories' and indexname = 'memories_scope_updated_at_id_idx'
      and indexdef ilike '%where (archived_at IS NULL)%'
  ) into v_partial;
  assert v_partial,
    'memories keyset: the covering index must stay partial on archived_at is null';

  -- The name and the predicate together still say nothing about the COLUMN
  -- LIST, and the column list IS the fix: an index of this exact name built as
  -- (scope, updated_at desc) — or with `id` ASC, which is 00012's residual
  -- mismatch — satisfies both assertions above while leaving the keyset seek
  -- exactly as uncovered as 00033 left it. `pg_get_indexdef` renders the
  -- ordered column list verbatim, the same catalog-rendered-text idiom AC-5
  -- above uses for `pg_get_expr(indpred)`.
  select exists (
    select 1 from pg_indexes
    where tablename = 'memories' and indexname = 'memories_scope_updated_at_id_idx'
      and indexdef ilike '%(scope, updated_at desc, id desc)%'
  ) into v_columns;
  assert v_columns,
    'memories keyset: the covering index must be on (scope, updated_at desc, id desc) '
    'in that order — a same-named index over other columns is not the fix';
end;
$$;

-- ── 62. lorekit_memory_set_embedding: org-owned rows are embeddable, and the
--        role gate survives (00062) ──────────────────────────────────────────
-- The regression this pins: `rls_read` was widened for orgs in 00015,
-- `rls_update` (00001) never was. An org-owned memory has `user_id is null`
-- (00019), so a JWT client's direct UPDATE matched zero rows and PostgREST
-- called that success — every org memory silently went unembedded.
--
-- AC-1 asserts the OLD path is still broken (a direct update matches nothing),
-- because that is the only way this test can prove the RPC is load-bearing
-- rather than decorative. AC-2 asserts the new path works for the same caller.
-- AC-3 is the reason this is an RPC and not a widened policy: a VIEWER must be
-- refused, which RLS cannot express.
insert into orgs (id, slug, name, created_by) values
  ('00000000-0000-0000-0000-0000000e6201', 'embed-org', 'Embed Org',
   '00000000-0000-0000-0000-0000000000a1');

insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e6201', '00000000-0000-0000-0000-0000000000a1', 'member'),
  ('00000000-0000-0000-0000-0000000e6201', '00000000-0000-0000-0000-0000000000b2', 'viewer');

-- An org-owned memory as 00019 writes one: org_id set, user_id NULL.
insert into memories (id, user_id, org_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000e6210', null, '00000000-0000-0000-0000-0000000e6201',
   'global', 'embed-org-row', 'org owned value'),
  ('00000000-0000-0000-0000-0000000e6211', '00000000-0000-0000-0000-0000000000a1', null,
   'global', 'embed-personal-row', 'personal value');

do $$
declare
  -- Built rather than typed, matching the 00060 section above.
  v_vec      text := '[' || array_to_string(array_fill(0.001::real, array[1536]), ',') || ']';
  v_direct   int := 0;
  v_ok       boolean;
  v_model    text;
  v_denied   boolean;
  v_gone     boolean;
  v_paired   boolean := false;
begin
  -- ── AC-1: the old direct-update path does NOT land for a JWT caller ───────
  -- Either it matches zero rows (rls_update's USING excludes the org-owned row)
  -- or the role lacks table UPDATE entirely. Both prove the same thing — a JWT
  -- client cannot write this row directly — and which one applies depends on
  -- Supabase's default table grants rather than on anything this repo declares.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  begin
    with upd as (
      update memories set embedding = v_vec::vector, embedding_model = 'probe'
       where id = '00000000-0000-0000-0000-0000000e6210'
      returning 1
    )
    select count(*) into v_direct from upd;
  exception when insufficient_privilege then
    v_direct := 0;
  end;

  reset role;

  assert v_direct = 0,
    format('00062 AC-1: a JWT-scoped direct UPDATE on an org-owned memory must not land '
           '(that asymmetry between rls_read and rls_update is the bug 00062 routes around), '
           'but it matched %s row(s). If this now succeeds, rls_update was widened — check '
           'that the org ROLE gate did not go with it', v_direct);

  -- ── AC-2: the RPC writes the same row for the same caller ─────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  select written into v_ok
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e6210', null, v_vec, 'text-embedding-3-small');

  reset role;

  assert v_ok,
    '00062 AC-2: a write-capable org member must be able to embed an org-owned memory';

  select embedding_model into v_model
    from memories where id = '00000000-0000-0000-0000-0000000e6210';
  assert v_model = 'text-embedding-3-small',
    format('00062 AC-2: embedding_model should be written alongside the vector, got %s', v_model);

  -- ── AC-3: a VIEWER is refused — the role gate RLS cannot express ──────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);

  select written into v_denied
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e6210', null, v_vec, 'sneaky-model');

  reset role;

  assert not v_denied,
    '00062 AC-3: an org VIEWER must NOT be able to write an embedding — this is exactly what '
    'widening rls_update instead of adding this RPC would have permitted';

  select embedding_model into v_model
    from memories where id = '00000000-0000-0000-0000-0000000e6210';
  assert v_model = 'text-embedding-3-small',
    format('00062 AC-3: the viewer''s denied call must not have altered the row, model is now %s', v_model);

  -- ── AC-4: personal rows — owner writes, a stranger does not ───────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select written into v_ok
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e6211', null, v_vec, 'text-embedding-3-small');
  reset role;
  assert v_ok, '00062 AC-4: the owner of a personal memory must be able to embed it';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
  select written into v_denied
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e6211', null, v_vec, 'stranger-model');
  reset role;
  assert not v_denied,
    '00062 AC-4: a user who does not own a personal memory must not be able to embed it';

  -- ── AC-5: a row that no longer exists is false, not an exception ──────────
  -- The caller is a backgrounded task whose contract is "never fail a write".
  select written into v_gone
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e62ff', null, v_vec, 'text-embedding-3-small');
  assert not v_gone,
    '00062 AC-5: a missing memory id must return false rather than raising';

  -- ── AC-6: the 00060 both-or-neither pairing is refused by NAME ────────────
  begin
    perform lorekit_memory_set_embedding(
              '00000000-0000-0000-0000-0000000e6211', null, v_vec, null);
  exception when others then
    v_paired := sqlerrm like '%must be set together%';
  end;
  assert v_paired,
    '00062 AC-6: supplying a vector without a model must be refused with a named reason, '
    'not left to surface as an opaque CHECK violation inside a background task';
end;
$$;

-- AC-7: grant surface. Postgres grants EXECUTE to PUBLIC by default and `anon`
-- inherits it, so the migration's explicit REVOKE is what makes this pass —
-- the same trap 00041 documents and this assertion is why it stays caught.
do $$
declare
  v_sig text := 'lorekit_memory_set_embedding(uuid, uuid, text, text)';
begin
  assert not has_function_privilege('anon', v_sig, 'EXECUTE'),
    '00062 AC-7: lorekit_memory_set_embedding must NOT be executable by anon';
  assert has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    '00062 AC-7: lorekit_memory_set_embedding must be executable by authenticated';
  assert has_function_privilege('service_role', v_sig, 'EXECUTE'),
    '00062 AC-7: lorekit_memory_set_embedding must be executable by service_role';
end;
$$;

-- ── 62b. An embedding write must not restamp `updated_at` (00062) ───────────
-- `updated_at` is the recency signal search/relevant order by, memory.list
-- keysets on, and lesson-rank scores. The vector is a DERIVED artefact, so
-- writing one is not an edit. A whole-store backfill would otherwise restamp
-- every row in `created_at desc` order and destroy the real ordering, with no
-- way to recover the old values.
--
-- AC-1 pins the preservation, AC-2 pins that a REAL edit still bumps (a trigger
-- that never stamps would pass AC-1 while breaking every consumer), and AC-3
-- pins that an edit arriving together with an embedding still counts as an edit.
insert into memories (id, user_id, scope, key, value, updated_at) values
  ('00000000-0000-0000-0000-0000000e6220', '00000000-0000-0000-0000-0000000000a1',
   'global', 'embed-stamp-row', 'original value', '2020-01-01T00:00:00Z'),
  -- AC-3 needs its own row: `now()` does not advance within a transaction, so a
  -- reset-then-compare on the first row could never show a bump. See the note there.
  ('00000000-0000-0000-0000-0000000e6221', '00000000-0000-0000-0000-0000000000a1',
   'global', 'embed-stamp-row-2', 'original value', '2020-01-01T00:00:00Z'),
  -- AC-6 likewise: it asserts a no-op re-write STILL bumps, which needs a row
  -- whose stamp is unambiguously old.
  ('00000000-0000-0000-0000-0000000e6222', '00000000-0000-0000-0000-0000000000a1',
   'global', 'embed-stamp-row-3', 'original value', '2020-01-01T00:00:00Z');

do $$
declare
  v_vec     text := '[' || array_to_string(array_fill(0.001::real, array[1536]), ',') || ']';
  v_before  timestamptz;
  v_after   timestamptz;
  v_ok      boolean;
begin
  select updated_at into v_before from memories where id = '00000000-0000-0000-0000-0000000e6220';
  assert v_before = '2020-01-01T00:00:00Z'::timestamptz,
    format('00062b AC-1 setup: the seeded updated_at should be untouched, got %s', v_before);

  -- AC-1 — an embedding-only write preserves it.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  select written into v_ok
    from lorekit_memory_set_embedding(
           '00000000-0000-0000-0000-0000000e6220', null, v_vec, 'text-embedding-3-small');
  reset role;

  assert v_ok, '00062b AC-1 setup: the embedding write should have landed';

  select updated_at into v_after from memories where id = '00000000-0000-0000-0000-0000000e6220';
  assert v_after = v_before,
    format('00062b AC-1: an embedding-only write must NOT restamp updated_at — was %s, now %s. '
           'A backfill doing this to every row rewrites the store''s recency ordering irrecoverably',
           v_before, v_after);

  -- AC-2 — a real edit still bumps it. Without this, a trigger that simply
  -- never stamped would satisfy AC-1 while silently breaking every consumer.
  update memories set value = 'edited value' where id = '00000000-0000-0000-0000-0000000e6220';
  select updated_at into v_after from memories where id = '00000000-0000-0000-0000-0000000e6220';
  assert v_after > v_before,
    format('00062b AC-2: editing a memory must still bump updated_at, stayed at %s', v_after);

  -- AC-3 — an edit that ALSO rewrites the vector is still an edit.
  --
  -- On a SECOND row seeded at 2020, not by resetting the first one, because
  -- `now()` is the TRANSACTION timestamp and does not advance inside one — so
  -- comparing two stamps taken in this transaction could never show an increase,
  -- and the assertion would be vacuous however the reset behaved.
  --
  -- (An earlier revision of the trigger gave a second reason: a lone
  -- `update … set updated_at = …` was preserved, so the reset silently no-oped.
  -- That is no longer true — AC-6 below asserts such a write BUMPS, because the
  -- trigger now requires the embedding columns to have actually moved. The
  -- separate row is still the right shape for the timestamp reason above.)
  --
  -- Seeding through INSERT is what makes it work: there is no BEFORE INSERT
  -- trigger on `updated_at`, so the 2020 value survives and a bump is
  -- unmistakable.
  --
  -- Both embedding columns move together — the 00060 CHECK is both-or-neither,
  -- so setting `embedding_model` alone would fail on the constraint rather than
  -- testing the trigger.
  update memories
     set value = 'edited again',
         embedding = v_vec::vector,
         embedding_model = 'text-embedding-3-large'
   where id = '00000000-0000-0000-0000-0000000e6221';
  select updated_at into v_after from memories where id = '00000000-0000-0000-0000-0000000e6221';
  assert v_after > '2020-01-01T00:00:00Z'::timestamptz,
    format('00062b AC-3: a change touching both the value and the embedding columns is an edit '
           'and must bump updated_at, stayed at %s', v_after);

  -- AC-6 — a plain NO-OP re-write still bumps, i.e. this migration did not
  -- quietly change the recency contract for everything else.
  --
  -- `memory_write` UPSERTS, so an agent re-saving an identical lesson lands here
  -- with every column unchanged. Preserving `updated_at` for that case would
  -- silently stop re-saves from refreshing recency — a behaviour change reaching
  -- far beyond embeddings, in a migration whose entire claim is that a DERIVED
  -- column must not disturb the row. The trigger therefore requires a vector to
  -- have actually moved, and this is what holds it to that.
  update memories
     set updated_at = updated_at   -- no-op: rewrites the row, changes nothing
   where id = '00000000-0000-0000-0000-0000000e6222';
  select updated_at into v_after from memories where id = '00000000-0000-0000-0000-0000000e6222';
  assert v_after > '2020-01-01T00:00:00Z'::timestamptz,
    format('00062b AC-6: a no-op re-write must STILL bump updated_at — only a write that moves '
           'the embedding columns may preserve it. An upsert of an unchanged lesson is the '
           'common case here, and it must keep refreshing recency. Stayed at %s', v_after);
end;
$$;

-- AC-5: the generated-column list this trigger masks is still exactly `fts`.
--
-- This is the guard for the trap that broke the first attempt. Postgres computes
-- GENERATED columns AFTER before-row triggers, so inside the trigger `new.<gen>`
-- is NULL while `old.<gen>` holds a value — an unmasked generated column makes
-- EVERY update compare as changed and quietly turns the function back into
-- `set_updated_at`. It fails in the safe direction, so nothing else would catch
-- it. Adding a generated column to `memories` must therefore trip this and be
-- masked in `lorekit_memories_set_updated_at` too.
do $$
declare
  v_generated text[];
begin
  select coalesce(array_agg(column_name order by column_name), '{}')
    into v_generated
    from information_schema.columns
   where table_schema = 'public' and table_name = 'memories' and is_generated = 'ALWAYS';

  assert v_generated = array['fts'],
    format('00062b AC-5: memories now has generated columns %s, but '
           'lorekit_memories_set_updated_at only masks `fts`. An unmasked generated column is '
           'NULL in a BEFORE trigger while OLD holds a value, so every update compares as '
           'changed and updated_at is restamped on embedding-only writes again. Mask it there '
           'and update this assertion.', v_generated);
end;
$$;

-- AC-4: the five OTHER tables on the shared `set_updated_at` are untouched —
-- only the memories trigger was retargeted. Retargeting all of them would be a
-- behaviour change to tables that have no embedding column and no such problem.
do $$
declare
  v_fn text;
begin
  select p.proname into v_fn
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'memories' and t.tgname = 'memories_updated_at';
  assert v_fn = 'lorekit_memories_set_updated_at',
    format('00062b AC-4: the memories trigger must use lorekit_memories_set_updated_at, uses %s', v_fn);

  select p.proname into v_fn
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'orgs' and t.tgname = 'orgs_updated_at';
  assert v_fn = 'set_updated_at',
    format('00062b AC-4: orgs must still use the shared set_updated_at, uses %s', v_fn);
end;
$$;

-- ── 80. lorekit_match_text / _tags / _int — the shared predicates (00066) ────
-- Three inlinable helpers replace eight hand-written `case` blocks per caller.
-- The rule most likely to be lost in a copy — and the reason they exist — is
-- that `nin` requires the value to be NON-NULL, so an unattributed row is
-- EXCLUDED from a negated filter rather than silently dropped by NULL logic.
--
-- AC-1: a null filter is "not filtered" and matches everything.
-- AC-2: `in` is membership; `nin` its negation.
-- AC-3: a NULL column value satisfies neither `in` NOR `nin` — the load-bearing
--       asymmetry. `x <> all(...)` alone is NULL for a null x, which reads as
--       false, so "agent is not aw" would drop every unattributed memory.
-- AC-4: the helpers are TOTAL — they return a boolean, never NULL, for every
--       combination including a null value and a null mode.
-- AC-5: tags modes — `all` is containment, `any` overlap, `none` the negation
--       of `any` (never of `all`, which would admit "all but one").
-- AC-6: the integer helper compares NUMERICALLY, so `007` matches PR 7 exactly
--       as the list route does.
do $$
begin
  -- AC-1: null filter matches everything, whatever the mode says.
  assert lorekit_match_text('aw', null, 'in'),      'match_text AC-1: null filter must match';
  assert lorekit_match_text('aw', null, 'nin'),     'match_text AC-1: null filter must match under nin';
  assert lorekit_match_text(null, null, 'in'),      'match_text AC-1: null value + null filter must match';
  assert lorekit_match_tags(array['a'], null, 'all'), 'match_tags AC-1: null filter must match';
  assert lorekit_match_int(7, null, 'in'),          'match_int AC-1: null filter must match';

  -- AC-2: membership and its negation.
  assert lorekit_match_text('aw', array['aw','claude'], 'in'),
    'match_text AC-2: a listed value must match under in';
  assert not lorekit_match_text('other', array['aw'], 'in'),
    'match_text AC-2: an unlisted value must not match under in';
  assert lorekit_match_text('other', array['aw'], 'nin'),
    'match_text AC-2: an unlisted value must match under nin';
  assert not lorekit_match_text('aw', array['aw'], 'nin'),
    'match_text AC-2: a listed value must not match under nin';

  -- AC-3: THE asymmetry. A row with no value is excluded either way.
  assert not lorekit_match_text(null, array['aw'], 'in'),
    'match_text AC-3: a null value must not match a positive filter';
  assert not lorekit_match_text(null, array['aw'], 'nin'),
    'match_text AC-3: a null value must NOT satisfy a negated filter — that is the '
    'null test the helper exists to centralise';
  assert not lorekit_match_int(null, array[7], 'nin'),
    'match_int AC-3: the integer helper must share the null rule';

  -- AC-4: total — never NULL, so a caller can AND the result directly.
  assert lorekit_match_text(null, array['aw'], 'in') is not null,
    'match_text AC-4: must return a boolean, never NULL';
  assert lorekit_match_text('aw', array['aw'], null) is not null,
    'match_text AC-4: a null mode must default, not propagate NULL';
  assert lorekit_match_text('aw', array['aw'], null),
    'match_text AC-4: a null mode must default to `in`';
  assert lorekit_match_tags(array['a'], array['a'], null),
    'match_tags AC-4: a null mode must default to `any`';

  -- AC-5: the three tag modes.
  assert lorekit_match_tags(array['a','b'], array['a','b'], 'all'),
    'match_tags AC-5: containment holds when every label is present';
  assert not lorekit_match_tags(array['a'], array['a','b'], 'all'),
    'match_tags AC-5: containment fails when one label is missing';
  assert lorekit_match_tags(array['a'], array['a','b'], 'any'),
    'match_tags AC-5: overlap holds on one shared label';
  assert not lorekit_match_tags(array['a'], array['a','b'], 'none'),
    'match_tags AC-5: `none` must reject a row sharing ANY label';
  -- The discriminating case for `none` being NOT(any) rather than NOT(all):
  -- a row carrying every named label must be rejected, and so must one
  -- carrying just one of them (asserted above).
  assert not lorekit_match_tags(array['a','b'], array['a','b'], 'none'),
    'match_tags AC-5: `none` must reject a row carrying all named labels';
  assert lorekit_match_tags(array['c'], array['a','b'], 'none'),
    'match_tags AC-5: `none` must accept a row sharing no label';
  assert lorekit_match_tags('{}'::text[], array['a'], 'none'),
    'match_tags AC-5: a row with no labels shares none, so `none` accepts it';

  -- AC-6: numeric comparison, so a zero-padded entry still matches.
  assert lorekit_match_int(7, array[7], 'in'), 'match_int AC-6: 7 must match 7';
  assert lorekit_match_int(7, (select array_agg(x::integer) from unnest(array['007']) as x), 'in'),
    'match_int AC-6: `007` must resolve to 7 and match, exactly as GET /memories does';
end;
$$;

-- ── 81. lorekit_memory_list — the keyset page as a SQL function (00067) ──────
-- The list read moved into Postgres so a wide filter never becomes a URL. The
-- edge previously composed `or=(host.in.("a","b",…))` as a PostgREST QUERY
-- PARAM, so a dimension carrying a few hundred values built an internal request
-- the gateway refused — the same wall the JSON body removed on the client hop,
-- relocated one hop downstream where it surfaced as an unattributable 500.
--
-- AC-1: the page is ordered by the requested sort desc, then id desc.
-- AC-2: the keyset cursor resumes strictly after the named row, and the id
--       tie-break splits rows sharing a timestamp — the whole reason the
--       cursor carries both halves.
-- AC-3: WIDE dimensions are the point. A filter naming 1000 values, of which
--       exactly one is real, returns the one matching row. This is the case
--       that could not survive the URL transport at any layer.
-- AC-4: dimensions AND together while values within one OR together, and the
--       predicates are 00066's, so a `nin` over a NULL column behaves as
--       lorekit_memory_facets does.
-- AC-5: a value carrying a COMMA is reachable — unreachable over the query
--       transport by construction, and the reason the array form exists.
-- AC-6: the tenant boundary holds: another user's rows are never returned,
--       and the function is the ONLY predicate (no applyRestTenantScope).
--       BOTH actor branches are covered: service_role (v_actor = p_user_id)
--       and the `authenticated` JWT branch (v_actor = auth.uid()), where a
--       caller-supplied p_user_id must be ignored — that is the branch this
--       read has instead of RLS.
-- AC-7: `p_q` and `p_key_prefix` arrive already LIKE-escaped, so a literal `%`
--       stays data instead of widening to a wildcard.
-- AC-8: the archived / expired partition rule matches GET /memories'.
-- AC-9: an `origin_pr` entry that is all digits but too wide for int4 is
--       DROPPED like any other unusable entry — never a 22003 raised out of a
--       hand-editable filter value — while the zero-padded form still resolves.
--       A list whose every entry drops degrades to UNFILTERED, the same way an
--       all-non-numeric list already does on the facet catalog.
-- AC-10: `owner`, the one dimension restated inline rather than delegated to
--       00066's helpers, so it is the only one that can drift from
--       lorekit_memory_facets unnoticed — AC-10d asserts the two agree.
-- AC-9 needs one row carrying a real `origin_pr`, so the zero-padded half of a
-- mixed filter has something to match; every other row leaves it null.
insert into memories (user_id, scope, key, value, tags, source_agent, host, kind, origin_pr, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-1', 'alpha',   array['x'], 'aw',    'reviewer', 'lesson', 7,    '2026-01-09T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-2', 'beta',    array['y'], 'aw',    'aw',       'lesson', null, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
  -- Same updated_at as lr-2 on purpose: AC-2's id tie-break needs a real tie.
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-3', 'gamma',   array['y'], 'other', null,       null,     null, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
  -- A comma-bearing host: AC-5.
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-4', 'delta',   array['z'], 'aw',    'a,b',      'bus',    null, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
  -- A literal percent in the value: AC-7.
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-5', '100%pure',array['z'], 'aw',    'reviewer', 'bus',    null, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z');
insert into memories (user_id, scope, key, value, source_agent, archived_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'project::list-rpc', 'lr-archived', 'v', 'aw', now());
insert into memories (user_id, scope, key, value, source_agent) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::list-rpc-b', 'lr-b-1', 'v', 'aw');

do $$
declare
  v_keys   text[];
  v_rows   int;
  v_rows2  int;
  v_facet  bigint;
  v_wide   text[];
  v_ts     timestamptz;
  v_id     uuid;
  v_key    text;
  v_ts2    timestamptz;
  v_id2    uuid;
  v_i      int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-1: updated_at desc, id desc.
  select array_agg(key order by ord) into v_keys from (
    select key, row_number() over () as ord
      from lorekit_memory_list(
        '00000000-0000-0000-0000-0000000000a1'::uuid,
        p_scope => 'project::list-rpc', p_sort => 'updated_at', p_limit => 100)
  ) t;
  assert v_keys[1] = 'lr-5',
    format('list rpc AC-1: newest updated_at must lead, got %s', v_keys);
  assert v_keys[2] = 'lr-4',
    format('list rpc AC-1b: second must be lr-4, got %s', v_keys);
  assert array_length(v_keys, 1) = 5,
    format('list rpc AC-1c: the archived row must be excluded, got %s', v_keys);

  -- AC-2: resume after lr-4. The next page must start at the tie pair and must
  -- not repeat lr-4 or lr-5.
  select updated_at, id into v_ts, v_id
    from memories where scope = 'project::list-rpc' and key = 'lr-4';
  select array_agg(key order by ord) into v_keys from (
    select key, row_number() over () as ord
      from lorekit_memory_list(
        '00000000-0000-0000-0000-0000000000a1'::uuid,
        p_scope => 'project::list-rpc', p_sort => 'updated_at',
        p_cursor_ts => v_ts, p_cursor_id => v_id, p_limit => 100)
  ) t;
  assert not ('lr-4' = any(v_keys)) and not ('lr-5' = any(v_keys)),
    format('list rpc AC-2: the cursor must exclude its own row and everything above it, got %s', v_keys);
  assert array_length(v_keys, 1) = 3,
    format('list rpc AC-2b: three rows must remain, got %s', v_keys);

  -- AC-2c: the id tie-break. lr-2 and lr-3 share updated_at, so paginating
  -- with a limit of 1 from the tie must yield the other one and not loop.
  select updated_at, id into v_ts, v_id
    from memories where scope = 'project::list-rpc' and key = 'lr-2';
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_sort => 'updated_at',
      p_cursor_ts => v_ts, p_cursor_id => v_id, p_limit => 1);
  assert v_keys is null or not ('lr-2' = any(v_keys)),
    format('list rpc AC-2c: a cursor must never return its own row again, got %s', v_keys);

  -- AC-2d: AC-2c on its own does not pin the tie-break. Delete `m.id < $30` and
  -- the keyset degrades to `m.updated_at < $29`, which from lr-2's cursor lands
  -- on lr-1 — still "not lr-2", so AC-2c stays green while the sibling sharing
  -- lr-2's timestamp has been SKIPPED. Walking every page one row at a time is
  -- what sees that: with the tie-break the walk visits all five rows exactly
  -- once; without it lr-3 never appears and the walk returns four.
  v_keys := '{}'::text[];
  v_ts   := null;
  v_id   := null;
  for v_i in 1..10 loop
    v_key := null;
    select r.key, r.updated_at, r.id into v_key, v_ts2, v_id2
      from lorekit_memory_list(
        '00000000-0000-0000-0000-0000000000a1'::uuid,
        p_scope => 'project::list-rpc', p_sort => 'updated_at',
        p_cursor_ts => v_ts, p_cursor_id => v_id, p_limit => 1) r;
    exit when v_key is null;
    v_keys := v_keys || v_key;
    v_ts := v_ts2;
    v_id := v_id2;
  end loop;
  assert array_length(v_keys, 1) = 5,
    format('list rpc AC-2d: a one-row-at-a-time walk must visit all five active rows, got %s', v_keys);
  assert (select count(distinct k) from unnest(v_keys) k) = 5,
    format('list rpc AC-2d2: the walk must not repeat a row, got %s', v_keys);
  assert v_keys @> array['lr-2','lr-3'],
    format('list rpc AC-2d3: BOTH rows sharing an updated_at must be paged, which is what the id tie-break buys, got %s', v_keys);

  -- AC-3: THE case the URL transport could not carry. 1000 values, one real.
  select array_agg('filler-host-' || g) into v_wide from generate_series(1, 999) g;
  v_wide := v_wide || 'reviewer'::text;
  assert array_length(v_wide, 1) = 1000, 'list rpc AC-3: fixture must name 1000 values';
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_host => v_wide, p_host_mode => 'in', p_limit => 100);
  assert v_keys @> array['lr-1','lr-5'] and array_length(v_keys, 1) = 2,
    format('list rpc AC-3: a 1000-value dimension must return exactly its matches, got %s', v_keys);

  -- AC-4: AND across dimensions, OR within one.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_source_agent => array['aw'], p_kind => array['bus'], p_limit => 100);
  assert v_keys @> array['lr-4','lr-5'] and array_length(v_keys, 1) = 2,
    format('list rpc AC-4: agent AND kind must intersect, got %s', v_keys);

  -- AC-4b: `nin` over a NULLABLE column keeps the 00066 semantics — a row whose
  -- column is NULL is NOT admitted by the negation, exactly as the facet
  -- catalog counts it.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_host => array['reviewer'], p_host_mode => 'nin', p_limit => 100);
  assert not ('lr-3' = any(coalesce(v_keys, '{}'::text[]))),
    format('list rpc AC-4b: a NULL host must not satisfy `nin`, got %s', v_keys);

  -- AC-5: a comma-bearing value round-trips. Unreachable over `?host=a,b`,
  -- which splits it into two values that match nothing.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_host => array['a,b'], p_limit => 100);
  assert v_keys = array['lr-4'],
    format('list rpc AC-5: a comma-bearing value must match as ONE value, got %s', v_keys);

  -- AC-6: the tenant boundary. B's row is invisible to A even though the
  -- function is SECURITY DEFINER and the caller is service_role.
  select count(*) into v_rows
    from lorekit_memory_list('00000000-0000-0000-0000-0000000000a1'::uuid, p_limit => 1000)
   where key = 'lr-b-1';
  assert v_rows = 0, 'list rpc AC-6: another user''s row must never be returned';

  -- AC-6b: the OTHER actor branch. AC-6 runs as service_role, where v_actor
  -- comes from p_user_id; a JWT caller takes `v_actor := auth.uid()` instead,
  -- and that branch is what replaced RLS on this read — the function is
  -- SECURITY DEFINER, so nothing else narrows it. Adopt B's identity and pass
  -- A's id: the p_user_id must be IGNORED, so A's rows stay invisible and B
  -- sees only its own.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","email":"lk-list-b@test.local"}', true);
  select count(*) into v_rows
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_limit => 100);
  assert v_rows = 0,
    format('list rpc AC-6b: a JWT caller must act as auth.uid(), never the p_user_id it passes, got %s rows', v_rows);
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc-b', p_limit => 100);
  assert v_keys = array['lr-b-1'],
    format('list rpc AC-6b: the JWT branch must still return the caller''s OWN rows, got %s', v_keys);

  -- Back to service_role for the remaining assertions, which act as A.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- AC-7: a literal `%` in the needle is DATA. The escaped form matches only
  -- the row that really contains it; an unescaped `%` would match everything.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_q => '100\%pure', p_limit => 100);
  assert v_keys = array['lr-5'],
    format('list rpc AC-7: an escaped %% must stay literal, got %s', v_keys);

  -- AC-7b: key_prefix appends the one active wildcard.
  select count(*) into v_rows
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_key_prefix => 'lr-', p_limit => 100);
  assert v_rows = 5, format('list rpc AC-7b: the prefix must match the five active rows, got %s', v_rows);

  -- AC-8: the archived partition, GET /memories' rule verbatim.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_archived => true, p_scope => 'project::list-rpc', p_limit => 100);
  assert v_keys = array['lr-archived'],
    format('list rpc AC-8: the archived partition must hold exactly the archived row, got %s', v_keys);

  -- AC-8b: created_at is a real second sort order, not an alias of the first.
  -- lr-1 is the OLDEST by updated_at and the NEWEST by created_at, so the two
  -- orders disagree at the head — a regression collapsing v_sort back to
  -- updated_at leads with lr-5 and fails here. Without that skew in the fixture
  -- this assertion holds for both columns and proves nothing.
  select array_agg(key order by ord) into v_keys from (
    select key, row_number() over () as ord
      from lorekit_memory_list(
        '00000000-0000-0000-0000-0000000000a1'::uuid,
        p_scope => 'project::list-rpc', p_sort => 'created_at', p_limit => 2)
  ) t;
  assert v_keys[1] = 'lr-1',
    format('list rpc AC-8b: created_at desc must lead with lr-1, not the updated_at leader, got %s', v_keys);
  assert v_keys[2] = 'lr-5',
    format('list rpc AC-8b2: created_at desc must continue with lr-5, got %s', v_keys);
  assert array_length(v_keys, 1) = 2,
    format('list rpc AC-8c: p_limit must bound the page, got %s', v_keys);

  -- AC-9: an origin_pr entry that is all digits but wider than int4 is DROPPED
  -- like any other unusable entry, never raised. `^[0-9]+$` alone admits it and
  -- `x::integer` then raises 22003 — a 500 out of a hand-editable filter value.
  --
  -- When EVERY entry drops, `array_agg` over the empty set yields NULL, and a
  -- null filter is "not filtered" in lorekit_match_int — so the dimension
  -- degrades to unfiltered, exactly as an all-non-numeric list already does on
  -- lorekit_memory_facets. That degradation is the contract; what this pins is
  -- that reaching it does not RAISE.
  select count(*) into v_rows
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_origin_pr => array['99999999999'], p_limit => 100);
  assert v_rows = 5,
    format('list rpc AC-9: an out-of-int4 origin_pr must drop without raising, leaving the dimension unfiltered, got %s rows', v_rows);
  -- The same degradation an all-non-numeric list produces, asserted side by
  -- side so the two cannot drift apart.
  select count(*) into v_rows2
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_origin_pr => array['not-a-number'], p_limit => 100);
  assert v_rows2 = v_rows,
    format('list rpc AC-9a: an over-wide entry must degrade exactly like a non-numeric one, got %s vs %s', v_rows2, v_rows);

  -- AC-9b: the drop is per ENTRY, and the bound keeps the zero-padded form
  -- resolving numerically, so a list mixing the two still filters on its
  -- usable half rather than erroring or matching nothing.
  select array_agg(key) into v_keys
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_origin_pr => array['99999999999', '0000000007'], p_limit => 100);
  assert v_keys = array['lr-1'],
    format('list rpc AC-9b: the over-wide entry must drop while `0000000007` still matches PR 7, got %s', v_keys);

  -- AC-10: `owner`. It is the ONE dimension 00067 restates inline instead of
  -- delegating to 00066's lorekit_match_* helpers — it is a LEFT JOIN-computed
  -- identity (`personal` / org slug), not a scalar column — so it is the only
  -- one that can drift from lorekit_memory_facets without a shared helper
  -- catching it. Every fixture row here is personal (org_id null).
  select count(*) into v_rows
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_owner => array['personal'], p_limit => 100);
  assert v_rows = 5,
    format('list rpc AC-10: `personal` must admit every org-less row, got %s', v_rows);

  -- The negation is the half that disagrees if the inline expression is
  -- rewritten as a plain `<> all(...)` over a nullable identity.
  select count(*) into v_rows2
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc',
      p_owner => array['personal'], p_owner_mode => 'nin', p_limit => 100);
  assert v_rows2 = 0,
    format('list rpc AC-10b: `nin personal` must exclude every org-less row, got %s', v_rows2);

  -- A slug the caller cannot see resolves to nothing rather than widening the
  -- page: slugs are matched against the LEFT JOIN of VISIBLE orgs only.
  select count(*) into v_rows2
    from lorekit_memory_list(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc', p_owner => array['no-such-org'], p_limit => 100);
  assert v_rows2 = 0,
    format('list rpc AC-10c: an unknown owner slug must match nothing, got %s', v_rows2);

  -- AC-10d: the anti-drift assertion the inline restatement actually needs —
  -- the list's `personal` count must equal the facet catalog's `owner`/`personal`
  -- cell for the same caller and scope. If the two implementations of the owner
  -- identity ever disagree, this fails rather than the menu quietly showing a
  -- count the list does not honour.
  select f.count into v_facet
    from lorekit_memory_facets(
      '00000000-0000-0000-0000-0000000000a1'::uuid,
      p_scope => 'project::list-rpc') f
   where f.facet = 'owner' and f.value = 'personal';
  assert v_facet = v_rows,
    format('list rpc AC-10d: the owner count must agree with lorekit_memory_facets, list=%s facets=%s', v_rows, v_facet);

  -- Hand the transaction back as the migration owner. `set local role` is
  -- TRANSACTION-scoped, not block-scoped, so leaving `service_role` in place
  -- here leaks into every later section — and the next one seeds `auth.users`,
  -- which service_role may not write.
  reset role;
  perform set_config('request.jwt.claims', '', true);

end;
$$;

-- ── 82. api_tokens scoping — columns, CHECKs, predicates, RPC (00068) ───────
--
-- The FIRST assertions this file has ever carried about `api_tokens`. The table
-- has held an authorization record since 00002 with no DB-level proof of its
-- constraints; 00068 puts a second authorization decision on it, so the gap is
-- closed here rather than deferred again.
do $$
declare
  v_owner   uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  v_org_a   uuid;
  v_org_b   uuid;
  v_token   uuid;
  v_scopes  text[];
  v_access  text;
  v_ids     uuid[];
  v_failed  boolean;
begin
  -- Two orgs, the owner a member of only the first. `api_tokens.user_id`
  -- references `auth.users`, so the fixtures go in there first.
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated',
     'lk-mig-keyscope-owner@test.local', now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_other, 'authenticated', 'authenticated',
     'lk-mig-keyscope-other@test.local', now(), now());

  insert into orgs (slug, name, created_by) values ('scoping-org-a', 'A', v_owner)
    returning id into v_org_a;
  insert into orgs (slug, name, created_by) values ('scoping-org-b', 'B', v_other)
    returning id into v_org_b;
  insert into org_members (org_id, user_id, role) values (v_org_a, v_owner, 'owner');
  insert into org_members (org_id, user_id, role) values (v_org_b, v_other, 'owner');

  -- ── AC-1: a new key is unrestricted by default ────────────────────────────
  -- The load-bearing backwards-compatibility claim of 00068 decision 1: adding
  -- the columns must not narrow a single key that already exists.
  insert into api_tokens (user_id, name, token_prefix, token_hash)
  values (v_owner, 'scoping fixture', 'lk_rw_aaaa...', 'hash-scoping-fixture-0001')
  returning id into v_token;

  select scopes, org_access, org_ids into v_scopes, v_access, v_ids
  from api_tokens where id = v_token;

  assert v_scopes = '{}'::text[],
    'api_tokens AC-1: a new key must default to an EMPTY scope allowlist';
  assert v_access = 'all',
    'api_tokens AC-1: a new key must default to org_access = all';
  assert v_ids = '{}'::uuid[],
    'api_tokens AC-1: a new key must default to no org ids';
  assert lorekit_api_token_scope_allowed(v_scopes, 'repo::mthines/lorekit'),
    'api_tokens AC-1: an empty allowlist must permit every scope';
  assert lorekit_api_token_org_allowed(v_access, v_ids, v_org_a),
    'api_tokens AC-1: the default tenancy must permit every org';

  -- ── AC-2: the scope predicate ─────────────────────────────────────────────
  assert lorekit_api_token_scope_allowed(array['repo::mthines/lorekit'], 'repo::mthines/lorekit'),
    'scope_allowed AC-2: an exact pattern matches its own scope';
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/lorekit'], 'repo::mthines/gw-tools'),
    'scope_allowed AC-2: an exact pattern matches nothing else';
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/lorekit'], 'repo::mthines'),
    'scope_allowed AC-2: an exact pattern must not widen to its own prefix';
  assert lorekit_api_token_scope_allowed(array['repo::mthines/*'], 'repo::mthines/anything'),
    'scope_allowed AC-2: an owner wildcard matches by prefix';
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/*'], 'repo::someone/lorekit'),
    'scope_allowed AC-2: an owner wildcard must not cross the owner boundary';
  assert lorekit_api_token_scope_allowed(array['global', 'repo::mthines/*'], 'global'),
    'scope_allowed AC-2: patterns are OR-ed';

  -- The `::` half of the CHECK's `(/|::)` alternation. Everything above exercises
  -- the `/` branch only, and the two are different literal prefixes both in the
  -- regex and at match time — proving one says nothing about the other. The TS
  -- twin pins `project::*` and the docs advertise it, so SQL was the gap.
  assert lorekit_api_token_scope_allowed(array['project::*'], 'project::agent-skills'),
    'scope_allowed AC-2: a `::`-boundary wildcard matches by prefix';
  assert not lorekit_api_token_scope_allowed(array['project::*'], 'projectx::agent-skills'),
    'scope_allowed AC-2: a `::`-boundary wildcard must not cross the prefix boundary';

  -- The discriminating case for the LIKE escape. Without `replace(_, '\_')`,
  -- `_` is LIKE's single-character wildcard and the second assertion fails —
  -- which would silently widen every allowlist containing an underscore.
  assert lorekit_api_token_scope_allowed(array['repo::my_org/*'], 'repo::my_org/lorekit'),
    'scope_allowed AC-2: an underscore in the prefix still matches itself';
  assert not lorekit_api_token_scope_allowed(array['repo::my_org/*'], 'repo::myxorg/lorekit'),
    'scope_allowed AC-2: an underscore must stay LITERAL, not act as a LIKE wildcard';

  -- The scope-side twin of AC-3's NULL-element case, and it gets there by a
  -- different mechanism: `org_allowed` needed an explicit `coalesce(…, false)`
  -- because `= any(array[null])` is a scalar NULL, whereas here `right(null,1)`
  -- makes the CASE yield NULL, the WHERE drops the row, and `exists` is false by
  -- construction. Correct, but INCIDENTALLY correct — adding an `else` to that
  -- CASE would flip it to NULL with nothing failing. `is false`, not `not`,
  -- because `assert not NULL` also fails and would not discriminate.
  assert lorekit_api_token_scope_allowed(array[null]::text[], 'global') is false,
    'scope_allowed AC-2: a NULL pattern element must yield FALSE, never NULL';
  -- And it must not POISON the list: a good pattern alongside a NULL one still
  -- matches. This is the case a cargo-culted `coalesce` wrapper would break.
  assert lorekit_api_token_scope_allowed(array['global', null]::text[], 'global'),
    'scope_allowed AC-2: a NULL element must not suppress a sibling pattern that matches';

  -- Fail closed on a scopeless operation, but only for a RESTRICTED key.
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/*'], null),
    'scope_allowed AC-2: a restricted key must not reach a scopeless operation';
  assert lorekit_api_token_scope_allowed('{}'::text[], null),
    'scope_allowed AC-2: an unrestricted key still reaches a scopeless operation';

  -- AC-2b (00069): a pattern outside SCOPE_PATTERN's shape is DROPPED, not
  -- honoured as a prefix. `*` is a wildcard only directly after `/` or `::`, so
  -- a stored `repo::mthines/lore*` must not reach every repo starting with
  -- those letters — that would WIDEN the key, the one direction these
  -- predicates may never move. Pins the shape test itself: without this,
  -- deleting the `pattern ~ …` line leaves the suite green, while the two TS
  -- twins are pinned by tenant-scope.spec.ts and api-key.spec.ts.
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/lore*'], 'repo::mthines/lorekit'),
    'scope_allowed AC-2b: a mid-token wildcard must not prefix-match';
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/lore*'], 'repo::mthines/lore-other'),
    'scope_allowed AC-2b: a dropped pattern must not match anything beneath it';
  -- A key whose patterns ALL fail the shape test matches nothing — fail closed,
  -- never "no restriction".
  assert not lorekit_api_token_scope_allowed(array['repo::mthines/lore*'], 'global'),
    'scope_allowed AC-2b: an all-malformed allowlist must reach nothing';
  -- …and the two LEGAL wildcard positions are untouched.
  assert lorekit_api_token_scope_allowed(array['repo::mthines/*'], 'repo::mthines/lorekit'),
    'scope_allowed AC-2b: an owner wildcard still expands';
  assert lorekit_api_token_scope_allowed(array['project::*'], 'project::alpha'),
    'scope_allowed AC-2b: a prefix wildcard after `::` still expands';

  -- ── AC-3: the tenancy predicate ───────────────────────────────────────────
  assert lorekit_api_token_org_allowed('personal', '{}'::uuid[], null),
    'org_allowed AC-3: a personal row is reachable under every tenancy';
  assert not lorekit_api_token_org_allowed('personal', '{}'::uuid[], v_org_a),
    'org_allowed AC-3: `personal` must refuse every org';
  assert lorekit_api_token_org_allowed('selected', array[v_org_a], v_org_a),
    'org_allowed AC-3: `selected` admits a listed org';
  assert not lorekit_api_token_org_allowed('selected', array[v_org_a], v_org_b),
    'org_allowed AC-3: `selected` refuses an unlisted org';
  assert not lorekit_api_token_org_allowed('nonsense', '{}'::uuid[], v_org_a),
    'org_allowed AC-3: an unknown tenancy must fail CLOSED';

  -- `= any(array[null])` is NULL, so without the outer coalesce this predicate
  -- returns NULL — neither true nor false — out of an authorization check.
  -- `assert not` is the discriminating form: `assert` on a NULL fails, but so
  -- does `assert not NULL`, and only `is false` distinguishes the two. Written
  -- explicitly so a regression cannot pass as "not true".
  assert lorekit_api_token_org_allowed('selected', array[null]::uuid[], v_org_a) is false,
    'org_allowed AC-3: a NULL element must yield FALSE, never NULL, from the predicate';

  -- ── AC-4: the CHECKs actually reject ──────────────────────────────────────
  -- Each is asserted by attempting the write and catching, because a CHECK that
  -- exists but does not fire is indistinguishable from no CHECK at all.
  v_failed := false;
  begin
    update api_tokens set scopes = array['a,value.not.is.null'] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed,
    'api_tokens AC-4: a pattern outside the injection-guard charset must be rejected';

  v_failed := false;
  begin
    update api_tokens set scopes = array['repo::*/lorekit'] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: an INTERIOR wildcard must be rejected';

  v_failed := false;
  begin
    update api_tokens set org_access = 'everything' where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: an unknown org_access must be rejected';

  v_failed := false;
  begin
    update api_tokens set org_access = 'selected', org_ids = '{}'::uuid[] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: `selected` with no org ids must be rejected';

  v_failed := false;
  begin
    update api_tokens set org_access = 'personal', org_ids = array[v_org_a] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed,
    'api_tokens AC-4: org ids under a tenancy that does not use them must be rejected';

  v_failed := false;
  begin
    update api_tokens
       set scopes = (select array_agg('project::p' || i) from generate_series(1, 51) as i)
     where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: a 51-pattern allowlist must be rejected (cardinality cap)';

  -- The org-list twin of the cap above. `org_access` is set to 'selected' in the
  -- SAME statement on purpose: with the tenancy left at 'all', a non-empty
  -- org_ids also violates api_tokens_org_ids_match_access, and BOTH constraints
  -- raise check_violation — so the assertion would pass while proving the wrong
  -- one. Under 'selected' the match constraint is satisfied (selected = true,
  -- cardinality > 0 = true), leaving api_tokens_org_ids_len as the only
  -- constraint the row can violate.
  v_failed := false;
  begin
    update api_tokens
       set org_access = 'selected', org_ids = array_fill(v_org_a, array[51])
     where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: a 51-org list must be rejected (cardinality cap)';

  -- The org-list twin of the NULL-element case below. `{null}` has cardinality
  -- 1, so api_tokens_org_ids_len and api_tokens_org_ids_match_access are both
  -- satisfied under 'selected' — api_tokens_org_ids_not_null is the only
  -- constraint that can fire, which is what makes this assertion specific.
  v_failed := false;
  begin
    update api_tokens
       set org_access = 'selected', org_ids = array[null]::uuid[]
     where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed,
    'api_tokens AC-4: a NULL org id must be rejected, not read as an empty list';

  v_failed := false;
  begin
    update api_tokens set scopes = array['project::' || repeat('a', 200)] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'api_tokens AC-4: a pattern over 200 chars must be rejected';

  v_failed := false;
  begin
    update api_tokens set scopes = array['repo::mthines/lore*'] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed,
    'api_tokens AC-4: a trailing wildcard off a segment boundary must be rejected';

  v_failed := false;
  begin
    update api_tokens set scopes = array[null]::text[] where id = v_token;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed,
    'api_tokens AC-4: a NULL element must be INVALID, not unknown-therefore-fine';

  -- The accept side of the same alternation: the CHECK must admit a
  -- `::`-boundary wildcard, not only a `/` one. Without this the regex could be
  -- narrowed to `/` alone and every assertion above would still pass, while the
  -- TS twin and the docs kept advertising `project::*`.
  update api_tokens set scopes = array['project::*'] where id = v_token;
  select scopes into v_scopes from api_tokens where id = v_token;
  assert v_scopes = array['project::*'],
    'api_tokens AC-4: a `::`-boundary wildcard must be accepted';

  -- A valid pair still lands — the CHECKs must not be so tight that the
  -- feature is unusable.
  update api_tokens
     set scopes = array['repo::mthines/*'], org_access = 'selected', org_ids = array[v_org_a]
   where id = v_token;
  select scopes, org_access into v_scopes, v_access from api_tokens where id = v_token;
  assert v_scopes = array['repo::mthines/*'] and v_access = 'selected',
    'api_tokens AC-4: a valid scoping must be accepted';

  -- ── AC-5: the RPC is owner-only and membership-checked ────────────────────
  -- The AC-4 block above wrote as the migration owner (superuser, RLS bypassed)
  -- because `api_tokens` deliberately has no UPDATE policy. From here the actor
  -- matters, so the session becomes a real `authenticated` JWT — the same shape
  -- sections 4–12 use for the org RPCs.
  --
  -- Acting as the OTHER user: the key is not theirs, so the call must RAISE
  -- rather than silently match zero rows and report success.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_other), true);

  -- The RPC raises DISTINCT sqlstates, so each refusal is caught by code rather
  -- than by `when others` — which would also pass on a typo, a missing function
  -- or a permissions error, i.e. on the test being wrong.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'all', '{}'::uuid[]);
  exception when no_data_found then v_failed := true;
  end;
  assert v_failed, 'set_scoping AC-5: a non-owner must get the not-found refusal (P0002)';

  -- Back as the owner: pointing the key at an org the OWNER is not in must be
  -- refused, or the row would record access that does not exist.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_owner), true);

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'selected', array[v_org_b]);
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a non-member org must get the permission refusal (42501)';

  -- The RPC RE-STATES the table's five CHECKs so a bad argument comes back as a
  -- legible LK004 instead of a raw constraint-violation string. Duplicated logic
  -- drifts from its original unless something asserts it, and AC-4 only proves
  -- the CHECKs themselves — it writes as the migration owner and never enters
  -- this function. Each case therefore feeds ONE bad argument with the other
  -- three valid, and catches the RPC's own sqlstate (22023 =
  -- `invalid_parameter_value`) rather than `others`, for the same reason the
  -- refusals above catch theirs by code.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(
      v_token, array_fill('global'::text, array[51]), 'all', '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a 51-pattern allowlist must be refused with LK004';

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(
      v_token, array['a,value.not.is.null'], 'all', '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a malformed scope pattern must be refused with LK004';

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(
      v_token, '{}'::text[], 'selected', array_fill(v_org_a, array[51]));
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a 51-org list must be refused with LK004';

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'everything', '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: an unknown org_access must be refused with LK004';

  -- NULL is a THIRD case, not a variant of the one above: `null not in (…)` is
  -- NULL, so without the explicit `is null` the guard does not fire, and neither
  -- does the equality guard after it. The tenancy would reach the UPDATE and come
  -- back as a raw 23502 from the column's NOT NULL — an internal constraint name
  -- instead of an LK004. `invalid_parameter_value` here is therefore asserting
  -- that the re-statement is TOTAL, not merely present.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], null, '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a NULL org_access must be refused with LK004, not a raw NOT NULL violation';

  -- A NULL ARGUMENT is not the same as an empty array, and for `scopes` the
  -- difference is a widening: '{}' means UNRESTRICTED, so a coalesce here would
  -- turn `null` into "every scope the owner can see". Giving the arguments no
  -- DEFAULT only stops them being OMITTED; these two cases pin that an explicit
  -- null is refused as well.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, null, 'all', '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a NULL scopes argument must be refused, never coalesced to the unrestricted default';

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'all', null);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a NULL org_ids argument must be refused, never coalesced';

  -- The RPC's own re-statement of api_tokens_org_ids_not_null. It has to run
  -- BEFORE the membership guard, because that guard cannot see a NULL: the row
  -- IS selected into v_stray (`m.org_id = null` is NULL, so `not exists` holds)
  -- and `v_stray is not null` is then false. Catching LK004's 22023 rather than
  -- LK002's 42501 is what proves the ordering.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(
      v_token, '{}'::text[], 'selected', array[null]::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: a NULL org id must be refused with LK004, ahead of the membership guard';

  -- Both directions of the equality, because a one-sided implication would let
  -- one of them through: `selected` with no orgs, and a non-`selected` tenancy
  -- carrying orgs. The second uses v_org_a, an org the actor IS a member of, so
  -- it is the mismatch that refuses it and not the membership check below it.
  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'selected', '{}'::uuid[]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: `selected` with no org ids must be refused with LK004';

  v_failed := false;
  begin
    perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'personal', array[v_org_a]);
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed,
    'set_scoping AC-5: org ids under a tenancy that does not use them must be refused with LK004';

  -- And the happy path returns the row it wrote.
  select t.scopes, t.org_access, t.org_ids into v_scopes, v_access, v_ids
  from lorekit_api_token_set_scoping(v_token, array['global'], 'selected', array[v_org_a]) t;
  assert v_scopes = array['global'] and v_access = 'selected' and v_ids = array[v_org_a],
    'set_scoping AC-5: the RPC must return the scoping it persisted';

  -- Clearing it is how a key is un-scoped again (decision 1's other direction).
  perform lorekit_api_token_set_scoping(v_token, '{}'::text[], 'all', '{}'::uuid[]);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select scopes, org_access, org_ids into v_scopes, v_access, v_ids
  from api_tokens where id = v_token;
  assert v_scopes = '{}'::text[] and v_access = 'all' and v_ids = '{}'::uuid[],
    'set_scoping AC-5: clearing the scoping must restore the unrestricted default';
end;
$$;

-- ── 83. api_token scoping ENFORCEMENT — the eight functions 00069 teaches ───
--
-- §81 proved the predicates answer correctly in isolation. This proves the
-- functions that CONSUME them actually changed behaviour: the two mutation
-- gates (memory_write, memory_delete), which are the last unbypassable checks
-- on their paths, and the five per-scope aggregates (lorekit_memory_scopes,
-- _activity, lorekit_read_activity, _tags, _facets), each of which would
-- otherwise leak the very names scoping hides.
do $$
declare
  v_owner    uuid := gen_random_uuid();
  v_org      uuid;
  v_org_slug text := 'keyenf-org';
  v_scopes   text[];
  v_routed   boolean;
  v_binding  text;
  v_count    integer;
  v_failed   boolean;
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated',
          'lk-mig-keyenf@test.local', now(), now());

  insert into orgs (slug, name, created_by) values (v_org_slug, 'Key Enforcement', v_owner)
    returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, v_owner, 'owner');

  -- Adopt the service-role claim BEFORE any assertion, exactly as §80 does for
  -- lorekit_memory_scopes. Every aggregate 00069 re-issues resolves its actor
  -- with `case when auth.role() = 'service_role' then coalesce(p_user_id,
  -- auth.uid()) else auth.uid() end`, and memory_delete resolves its actor the
  -- same way. Without the claim `auth.role()` is NULL, so v_actor collapses to a
  -- NULL auth.uid(): the aggregates return NO rows and the AC-4/5/6 "must see"
  -- asserts fail while every "must not see" assert passes VACUOUSLY — the worst
  -- of both, since the narrowing this section exists to prove would be untested.
  -- Only the claim is set (no `set local role`), because auth.role() reads
  -- request.jwt.claims and the inserts above need the harness's own privileges.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── AC-1: an unscoped caller is completely unaffected ─────────────────────
  -- The defaults must reproduce the pre-00069 behaviour exactly, or this
  -- migration is a regression for every existing key, JWT session and CI run.
  select w.org_routed into v_routed
  from memory_write(
    p_user_id => v_owner, p_scope => 'repo::mthines/lorekit', p_key => 'k-default',
    p_value => 'v', p_org_slug => v_org_slug
  ) w;
  assert v_routed,
    'enforcement AC-1: an explicit org write must still route to the org by default';

  -- ── AC-2: the explicit-org branch refuses a key outside its tenancy ───────
  v_failed := false;
  begin
    perform memory_write(
      p_user_id => v_owner, p_scope => 'repo::mthines/lorekit', p_key => 'k-denied',
      p_value => 'v', p_org_slug => v_org_slug,
      p_key_org_access => 'personal', p_key_org_ids => '{}'::uuid[]
    );
  exception when sqlstate 'LK002' then v_failed := true;
  end;
  assert v_failed,
    'enforcement AC-2: a personal-only key must not write into a named org';

  -- ── AC-2b: the SCOPE allowlist is enforced on the write path too ──────────
  -- Both dispatchers already refuse a named scope outside the allowlist, but
  -- both run on the service-role client, so this RPC is the only gate a write
  -- cannot route around. Without it the allowlist half had no unbypassable
  -- enforcement at all, unlike the tenancy half AC-2 covers.
  v_failed := false;
  begin
    perform memory_write(
      p_user_id => v_owner, p_scope => 'repo::other/repo', p_key => 'k-scope-denied',
      p_value => 'v', p_key_scopes => array['repo::mthines/*']
    );
  exception when sqlstate 'LK002' then v_failed := true;
  end;
  assert v_failed,
    'enforcement AC-2b: a key allowlisted elsewhere must not write under repo::other/repo';

  -- …and the same key writing INSIDE its allowlist still succeeds, so AC-2b
  -- denies on the allowlist and not on some unrelated failure.
  perform memory_write(
    p_user_id => v_owner, p_scope => 'repo::mthines/allowed', p_key => 'k-scope-allowed',
    p_value => 'v', p_key_scopes => array['repo::mthines/*']
  );
  select count(*) into v_count from memories m
   where m.user_id = v_owner and m.scope = 'repo::mthines/allowed';
  assert v_count = 1,
    'enforcement AC-2b: a write INSIDE the allowlist must still land';

  -- ── AC-3: the binding branch — THE KEY WINS (00068 decision 4) ────────────
  -- Bind the scope to the org, then write with NO explicit org. A default
  -- caller is auto-routed; a personal-only key must fall back to a PERSONAL
  -- write instead — never rejected, and still told which org the scope belongs
  -- to, exactly as a non-member already is.
  -- Inserted directly rather than through `lorekit_scope_bind`, which resolves
  -- its actor from auth.uid() — null in this superuser block. The binding ROW is
  -- what memory_write reads; how it got there is 00026's concern, not this one.
  insert into org_scope_bindings (org_id, scope, created_by) values (v_org, 'repo::bound/repo', v_owner);

  select w.org_routed into v_routed
  from memory_write(
    p_user_id => v_owner, p_scope => 'repo::bound/repo', p_key => 'k-bound-default', p_value => 'v'
  ) w;
  assert v_routed,
    'enforcement AC-3: an unrestricted caller must still be auto-routed by the binding';

  select w.org_routed, w.binding_org_slug into v_routed, v_binding
  from memory_write(
    p_user_id => v_owner, p_scope => 'repo::bound/repo', p_key => 'k-bound-personal',
    p_value => 'v', p_key_org_access => 'personal', p_key_org_ids => '{}'::uuid[]
  ) w;
  assert not v_routed,
    'enforcement AC-3: a personal-only key must NOT be auto-routed into the bound org';
  assert v_binding = v_org_slug,
    'enforcement AC-3: the fallback must still report the bound org so the caller can be told';

  -- The same key pointed AT that org is routed — proving AC-3 denies on the
  -- tenancy and not on some unrelated failure.
  select w.org_routed into v_routed
  from memory_write(
    p_user_id => v_owner, p_scope => 'repo::bound/repo', p_key => 'k-bound-selected',
    p_value => 'v', p_key_org_access => 'selected', p_key_org_ids => array[v_org]
  ) w;
  assert v_routed,
    'enforcement AC-3: a key that DOES include the bound org must still be routed';

  -- ── AC-4: lorekit_memory_scopes honours the key's allowlist ───────────────
  -- Two personal scopes exist by now (repo::mthines/lorekit from AC-1 landed in
  -- the org, so seed a personal one explicitly) plus the bound-repo rows.
  perform memory_write(p_user_id => v_owner, p_scope => 'project::alpha', p_key => 'k-alpha', p_value => 'v');
  perform memory_write(p_user_id => v_owner, p_scope => 'project::beta',  p_key => 'k-beta',  p_value => 'v');

  select array_agg(s.scope order by s.scope) into v_scopes
  from lorekit_memory_scopes(v_owner) s;
  assert 'project::alpha' = any(v_scopes) and 'project::beta' = any(v_scopes),
    'enforcement AC-4: an unrestricted caller must still see every scope';

  select array_agg(s.scope order by s.scope) into v_scopes
  from lorekit_memory_scopes(v_owner, array['project::alpha']) s;
  assert v_scopes = array['project::alpha'],
    'enforcement AC-4: an allowlisted key must see ONLY its allowlisted scopes';

  select array_agg(s.scope order by s.scope) into v_scopes
  from lorekit_memory_scopes(v_owner, array['project::*']) s;
  assert 'project::alpha' = any(v_scopes) and 'project::beta' = any(v_scopes),
    'enforcement AC-4: a wildcard pattern must match every scope beneath it';
  assert not ('repo::bound/repo' = any(v_scopes)),
    'enforcement AC-4: a wildcard must not leak a scope outside its prefix';

  -- And the tenancy narrows the catalog too — otherwise a personal-only key
  -- still enumerates the org's repo names, which is the leak this closes.
  --
  -- The probe needs a name that exists ONLY on an org-owned row.
  -- `repo::bound/repo` cannot serve: AC-3's fallback wrote a PERSONAL row under
  -- that same name, and a `personal` key keeps its own rows by design, so the
  -- name legitimately survives the narrowing (asserted directly below).
  perform memory_write(
    p_user_id => v_owner, p_scope => 'repo::orgonly/repo', p_key => 'k-orgonly',
    p_value => 'v', p_org_slug => v_org_slug
  );

  select count(*) into v_count
  from lorekit_memory_scopes(v_owner) s
  where s.scope = 'repo::orgonly/repo';
  assert v_count = 1,
    'enforcement AC-4: an unrestricted caller must still enumerate the org-owned scope';

  select count(*) into v_count
  from lorekit_memory_scopes(v_owner, '{}'::text[], 'personal', '{}'::uuid[]) s
  where s.scope = 'repo::orgonly/repo';
  assert v_count = 0,
    'enforcement AC-4: a personal-only key must not enumerate an org-owned scope';

  -- The mixed case, and the reason the probe above needed its own scope: under
  -- `repo::bound/repo` the account holds two org rows (k-bound-default,
  -- k-bound-selected) and one personal row (k-bound-personal). A `personal` key
  -- must lose the org's two and keep its own one — the NAME survives with a
  -- narrower count rather than disappearing, which is what "narrows, never
  -- revokes" means for a scope the owner writes on both sides.
  select s.count into v_count
  from lorekit_memory_scopes(v_owner) s where s.scope = 'repo::bound/repo';
  assert v_count = 3,
    'enforcement AC-4: an unrestricted caller must count both the org rows and the personal one';

  select s.count into v_count
  from lorekit_memory_scopes(v_owner, '{}'::text[], 'personal', '{}'::uuid[]) s
  where s.scope = 'repo::bound/repo';
  assert v_count = 1,
    'enforcement AC-4: a personal-only key must keep its OWN row under a scope it also shares with an org';

  -- A personal-only key still sees its OWN scopes: `personal` narrows which
  -- ORGS are reachable, it never revokes the owner's own memories.
  select count(*) into v_count
  from lorekit_memory_scopes(v_owner, '{}'::text[], 'personal', '{}'::uuid[]) s
  where s.scope = 'project::alpha';
  assert v_count = 1,
    'enforcement AC-4: a personal-only key must still see its own personal scopes';

  -- ── AC-4b: memory_delete is gated on BOTH axes ────────────────────────────
  -- The org branch chooses its rows inside the function, so no transport-side
  -- filter reaches them. Without these guards it enforced the OWNER's role and
  -- nothing about the key: a personal-only key could hard-delete an org row.
  perform memory_write(
    p_user_id => v_owner, p_scope => 'repo::deltest/repo', p_key => 'k-del',
    p_value => 'v', p_org_slug => v_org_slug
  );

  v_failed := false;
  begin
    perform memory_delete(
      p_user_id => v_owner, p_org_slug => v_org_slug, p_scope => 'repo::deltest/repo',
      p_key => 'k-del', p_force => true,
      p_key_org_access => 'personal', p_key_org_ids => '{}'::uuid[]
    );
  exception when sqlstate 'LK002' then v_failed := true;
  end;
  assert v_failed,
    'enforcement AC-4b: a personal-only key must not delete an org-owned memory';

  v_failed := false;
  begin
    perform memory_delete(
      p_user_id => v_owner, p_org_slug => v_org_slug, p_scope => 'repo::deltest/repo',
      p_key => 'k-del', p_force => true, p_key_scopes => array['repo::other/*']
    );
  exception when sqlstate 'LK002' then v_failed := true;
  end;
  assert v_failed,
    'enforcement AC-4b: a key allowlisted elsewhere must not delete this scope';

  -- The unrestricted default still deletes, so AC-4b denies on the key and not
  -- on some unrelated failure.
  select count(*) into v_count
  from memory_delete(
    p_user_id => v_owner, p_org_slug => v_org_slug, p_scope => 'repo::deltest/repo',
    p_key => 'k-del', p_force => true
  ) d where d.deleted;
  assert v_count = 1,
    'enforcement AC-4b: an unrestricted caller must still delete the org-owned memory';

  -- ── AC-5: the two ACTIVITY series are narrowed the same way ───────────────
  -- `lorekit_memory_scopes` is not the only per-scope catalog: GET
  -- /memories/activity and /read-activity also return one row per scope NAME,
  -- so narrowing only the catalog would move the leak rather than close it.
  select array_agg(distinct a.scope order by a.scope) into v_scopes
  from lorekit_memory_activity(p_user_id => v_owner) a;
  assert 'project::alpha' = any(v_scopes) and 'project::beta' = any(v_scopes),
    'enforcement AC-5: an unrestricted caller must still see every scope in the activity series';

  select array_agg(distinct a.scope order by a.scope) into v_scopes
  from lorekit_memory_activity(p_user_id => v_owner, p_key_scopes => array['project::alpha']) a;
  assert v_scopes = array['project::alpha'],
    'enforcement AC-5: an allowlisted key must see ONLY its allowlisted scopes in the activity series';

  -- `repo::orgonly/repo`, not `repo::bound/repo`, for the reason AC-4 gives:
  -- only the former names a row the owner holds solely through the org.
  select count(*) into v_count
  from lorekit_memory_activity(p_user_id => v_owner) a
  where a.scope = 'repo::orgonly/repo';
  assert v_count = 1,
    'enforcement AC-5: an unrestricted caller must still see the org-owned scope in the activity series';

  select count(*) into v_count
  from lorekit_memory_activity(
    p_user_id => v_owner, p_key_org_access => 'personal', p_key_org_ids => '{}'::uuid[]
  ) a
  where a.scope = 'repo::orgonly/repo';
  assert v_count = 0,
    'enforcement AC-5: a personal-only key must not see an org-owned scope in the activity series';

  -- The read series, over its own ledger. `scope` is NULLABLE there — an
  -- unattributable read names nothing, so it must survive the allowlist rather
  -- than being dropped, or a scoped key's chart silently loses every event
  -- written before 00058.
  insert into usage_events (user_id, plan_name, tool_name, scope_type, auth_type, outcome,
                            duration_ms, result_count, scope, created_at) values
    (v_owner, 'free', 'memory.read', 'project', 'api_key', 'ok', 10, 5, 'project::alpha',
     timestamptz '2026-05-01 01:00:00+00'),
    (v_owner, 'free', 'memory.read', 'project', 'api_key', 'ok', 10, 7, 'project::beta',
     timestamptz '2026-05-01 02:00:00+00'),
    (v_owner, 'free', 'memory.read', 'unknown', 'api_key', 'ok', 10, 3, null,
     timestamptz '2026-05-01 03:00:00+00');

  select array_agg(distinct r.scope order by r.scope) into v_scopes
  from lorekit_read_activity(v_owner, 'day', timestamptz '2026-05-01 00:00:00+00',
                             timestamptz '2026-05-02 00:00:00+00', null,
                             array['project::alpha']) r
  where r.scope is not null;
  assert v_scopes = array['project::alpha'],
    'enforcement AC-5: an allowlisted key must not see another scope NAME in the read series';

  select count(*) into v_count
  from lorekit_read_activity(v_owner, 'day', timestamptz '2026-05-01 00:00:00+00',
                             timestamptz '2026-05-02 00:00:00+00', null,
                             array['project::alpha']) r
  where r.scope is null;
  assert v_count = 1,
    'enforcement AC-5: an unattributable read names nothing and must survive the allowlist';

  -- ── AC-6: the tag and facet catalogs are narrowed too ─────────────────────
  -- `origin_repo` is a repository name by construction, so the facet list is a
  -- scope-name catalog wearing a different hat. Narrowing four of six aggregate
  -- endpoints moves the leak rather than closing it.
  perform memory_write(
    p_user_id => v_owner, p_scope => 'project::alpha', p_key => 'k-facet-a',
    p_value => 'v', p_tags => array['tag-alpha'], p_origin_repo => 'mthines/alpha'
  );
  perform memory_write(
    p_user_id => v_owner, p_scope => 'project::beta', p_key => 'k-facet-b',
    p_value => 'v', p_tags => array['tag-beta'], p_origin_repo => 'mthines/beta'
  );

  select count(*) into v_count
  from lorekit_memory_facets(p_user_id => v_owner, p_key_scopes => array['project::alpha']) f
  where f.facet = 'origin_repo' and f.value = 'mthines/beta';
  assert v_count = 0,
    'enforcement AC-6: an allowlisted key must not see a repo name from outside its allowlist';

  select count(*) into v_count
  from lorekit_memory_facets(p_user_id => v_owner, p_key_scopes => array['project::alpha']) f
  where f.facet = 'origin_repo' and f.value = 'mthines/alpha';
  assert v_count = 1,
    'enforcement AC-6: the facet inside the allowlist must still be listed';

  select count(*) into v_count
  from lorekit_memory_tags(p_user_id => v_owner, p_key_scopes => array['project::alpha']) t
  where t.tag = 'tag-beta';
  assert v_count = 0,
    'enforcement AC-6: an allowlisted key must not see a label from outside its allowlist';

  select count(*) into v_count
  from lorekit_memory_tags(p_user_id => v_owner) t where t.tag = 'tag-beta';
  assert v_count = 1,
    'enforcement AC-6: an unrestricted caller must still see every label';

  -- Leave the session as this block found it, so a section appended after this
  -- one does not silently inherit a service-role actor (§80's `reset role` +
  -- empty-claims pairing, minus the role it never set).
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 84. API token scope-authorized removal + not-found/forbidden signal (00071) ─
-- 00071 lets a key with a NON-EMPTY scope allowlist, reaching memory_delete on
-- the service-role connection, manage any writer's row WITHIN its allowlist —
-- while an UNSCOPED key and any non-service-role caller stay pinned to their own
-- rows (the 00046 actor guard is untouched). It also returns `existed`, so a
-- 0-row removal is reported as not_found vs forbidden instead of a silent false.
--
-- Owner under test = user A (…a1). Every row here is written by user B (…b2), a
-- DIFFERENT principal, so ownership can never be what authorises the removal —
-- only the key's scoping can.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::managed', 'sar-arch', 'written by B'),
  ('00000000-0000-0000-0000-0000000000b2', 'project::managed', 'sar-keep', 'written by B'),
  ('00000000-0000-0000-0000-0000000000b2', 'project::managed', 'sar-hard', 'written by B'),
  ('00000000-0000-0000-0000-0000000000b2', 'project::other',   'sar-out',  'written by B');

-- An org-owned row under phase2-org (f2, seeded in §11 with A as owner) exercises
-- the org branch's new `existed` column in case (6).
insert into memories (user_id, org_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2',
   'project::managed', 'sar-org-row', 'org-owned by phase2-org');

do $$
declare
  r       record;
  v_count int;
begin
  -- (1) service-role + SCOPED key archives another writer's in-allowlist row.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-arch',
    p_force      => false,
    p_key_scopes => array['project::managed']);
  assert r.archived and r.existed and not r.deleted,
    format('SAR-1: a scoped key must archive an in-allowlist row it does not own (archived=%s existed=%s deleted=%s)',
           r.archived, r.existed, r.deleted);
  select count(*) into v_count from memories
    where scope = 'project::managed' and key = 'sar-arch' and archived_at is not null;
  assert v_count = 1, 'SAR-1: the row must actually be archived';

  -- (1b) and hard-delete it, too.
  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-hard',
    p_force      => true,
    p_key_scopes => array['project::managed']);
  assert r.deleted and r.existed and not r.archived,
    format('SAR-1b: a scoped key must hard-delete an in-allowlist row it does not own (deleted=%s)', r.deleted);
  select count(*) into v_count from memories
    where scope = 'project::managed' and key = 'sar-hard';
  assert v_count = 0, 'SAR-1b: the row must actually be gone';

  -- (7) re-archiving the now ALREADY-archived sar-arch reports existed=true
  --     (present), never not_found — the row is there, just nothing active to
  --     archive. This is the case that would otherwise masquerade as not_found.
  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-arch',
    p_force      => false,
    p_key_scopes => array['project::managed']);
  assert (not r.archived) and r.existed,
    format('SAR-7: re-archiving an already-archived row must report existed=true, not not_found (archived=%s existed=%s)',
           r.archived, r.existed);

  -- (2) service-role + UNSCOPED key must NOT touch another writer's row; and
  --     `existed` must report it present, i.e. forbidden — not not-found.
  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-keep',
    p_force      => false,
    p_key_scopes => array[]::text[]);
  assert (not r.archived) and (not r.deleted) and r.existed,
    format('SAR-2: an UNSCOPED key must not archive another user''s row, and existed must be true (archived=%s existed=%s)',
           r.archived, r.existed);
  select count(*) into v_count from memories
    where scope = 'project::managed' and key = 'sar-keep' and archived_at is null;
  assert v_count = 1, 'SAR-2: the unscoped key must have left the row active';

  -- (3) not_found: a scoped key on a missing key removes nothing, existed=false.
  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-missing',
    p_force      => false,
    p_key_scopes => array['project::managed']);
  assert (not r.archived) and (not r.existed),
    format('SAR-3: a missing key must report existed=false / not_found (existed=%s)', r.existed);

  -- (4) the scope allowlist STILL bounds a scoped key: a scope OUTSIDE the
  --     allowlist is refused with LK002 before any widening can reach it.
  begin
    perform memory_delete(
      p_user_id    => '00000000-0000-0000-0000-0000000000a1',
      p_org_slug   => null,
      p_scope      => 'project::other',
      p_key        => 'sar-out',
      p_force      => false,
      p_key_scopes => array['project::managed']);
    assert false, 'SAR-4: a scope outside the allowlist must raise LK002';
  exception when sqlstate 'LK002' then
    null; -- expected
  end;
  select count(*) into v_count from memories
    where scope = 'project::other' and key = 'sar-out' and archived_at is null;
  assert v_count = 1, 'SAR-4: the out-of-allowlist row must be untouched';

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- (5) a raw AUTHENTICATED caller cannot widen with a request-supplied
  --     p_key_scopes — auth.uid() pins the actor (00046), so B's row survives
  --     and `existed` does not leak it. User C (…c3) is the would-be attacker.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
  select * into r from memory_delete(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',   -- spoofed; ignored off service_role
    p_org_slug   => null,
    p_scope      => 'project::managed',
    p_key        => 'sar-keep',
    p_force      => false,
    p_key_scopes => array['project::managed']);               -- request input; must NOT widen
  assert (not r.archived) and (not r.existed),
    format('SAR-5: a request-supplied p_key_scopes must not let an authenticated caller widen (archived=%s existed=%s)',
           r.archived, r.existed);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from memories
    where scope = 'project::managed' and key = 'sar-keep' and archived_at is null;
  assert v_count = 1, 'SAR-5: B''s row must survive the authenticated caller''s spoof attempt';

  -- (6) the org branch carries `existed` too: A (owner of phase2-org) archives
  --     an org-owned memory and gets archived=true alongside existed=true. The
  --     org capability gate is 00068 verbatim; this only pins the new column.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select * into r from memory_delete(
    p_user_id  => '00000000-0000-0000-0000-0000000000a1',
    p_org_slug => 'phase2-org',
    p_scope    => 'project::managed',
    p_key      => 'sar-org-row',
    p_force    => false);
  assert r.archived and r.existed and not r.deleted,
    format('SAR-6: an org archive must report archived + existed (archived=%s existed=%s)',
           r.archived, r.existed);
  select count(*) into v_count from memories
    where org_id = '00000000-0000-0000-0000-0000000000f2' and key = 'sar-org-row' and archived_at is not null;
  assert v_count = 1, 'SAR-6: the org row must actually be archived';
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 85. API token scope-authorized RESTORE + not-found/forbidden signal (00072) ─
-- The restore-side symmetry of §83: a scoped key restores any writer's archived
-- row within its allowlist; an unscoped key and any non-service-role caller stay
-- own-rows-only; `existed` (scoped to ARCHIVED rows) distinguishes forbidden
-- from not_found. Rows are archived up front (archived_at set) and written by B.
insert into memories (user_id, scope, key, value, archived_at) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::rmanaged', 'res-arch', 'archived by B', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'project::rmanaged', 'res-keep', 'archived by B', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'project::rother',   'res-out',  'archived by B', now());
-- An ACTIVE (non-archived) row: there is nothing to restore, so it must read as
-- not_found (existed=false), never forbidden.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::rmanaged', 'res-active', 'active, by B');

do $$
declare
  r       record;
  v_count int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- (1) scoped key restores another writer's archived in-allowlist row.
  select * into r from restore_memory(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_scope      => 'project::rmanaged',
    p_key        => 'res-arch',
    p_key_scopes => array['project::rmanaged']);
  assert r.restored and r.existed,
    format('SAR-R1: a scoped key must restore an in-allowlist row it does not own (restored=%s existed=%s)',
           r.restored, r.existed);
  select count(*) into v_count from memories
    where scope = 'project::rmanaged' and key = 'res-arch' and archived_at is null;
  assert v_count = 1, 'SAR-R1: the row must actually be un-archived';

  -- (2) UNSCOPED key must NOT restore another writer's row; existed=true.
  select * into r from restore_memory(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_scope      => 'project::rmanaged',
    p_key        => 'res-keep',
    p_key_scopes => array[]::text[]);
  assert (not r.restored) and r.existed,
    format('SAR-R2: an UNSCOPED key must not restore another user''s row, existed must be true (restored=%s existed=%s)',
           r.restored, r.existed);
  select count(*) into v_count from memories
    where scope = 'project::rmanaged' and key = 'res-keep' and archived_at is not null;
  assert v_count = 1, 'SAR-R2: the row must stay archived';

  -- (3) not_found: a missing key AND an ACTIVE (nothing-to-restore) row both
  --     report existed=false — there is no restorable row.
  select * into r from restore_memory(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_scope      => 'project::rmanaged',
    p_key        => 'res-missing',
    p_key_scopes => array['project::rmanaged']);
  assert (not r.restored) and (not r.existed), 'SAR-R3a: a missing key must report existed=false';
  select * into r from restore_memory(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_scope      => 'project::rmanaged',
    p_key        => 'res-active',
    p_key_scopes => array['project::rmanaged']);
  assert (not r.restored) and (not r.existed),
    format('SAR-R3b: an active (non-archived) row is not restorable → existed=false (existed=%s)', r.existed);

  -- (4) scope allowlist still bounds a scoped key.
  begin
    perform restore_memory(
      p_user_id    => '00000000-0000-0000-0000-0000000000a1',
      p_scope      => 'project::rother',
      p_key        => 'res-out',
      p_key_scopes => array['project::rmanaged']);
    assert false, 'SAR-R4: a scope outside the allowlist must raise LK002';
  exception when sqlstate 'LK002' then
    null; -- expected
  end;
  select count(*) into v_count from memories
    where scope = 'project::rother' and key = 'res-out' and archived_at is not null;
  assert v_count = 1, 'SAR-R4: the out-of-allowlist row must stay archived';

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- (5) an authenticated caller cannot widen with request-supplied p_key_scopes.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', true);
  select * into r from restore_memory(
    p_user_id    => '00000000-0000-0000-0000-0000000000a1',
    p_scope      => 'project::rmanaged',
    p_key        => 'res-keep',
    p_key_scopes => array['project::rmanaged']);
  assert (not r.restored) and (not r.existed),
    format('SAR-R5: a request-supplied p_key_scopes must not let an authenticated caller widen (restored=%s existed=%s)',
           r.restored, r.existed);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from memories
    where scope = 'project::rmanaged' and key = 'res-keep' and archived_at is not null;
  assert v_count = 1, 'SAR-R5: B''s archived row must survive the authenticated caller''s spoof attempt';
end;
$$;

-- ── 86. The SERVICE tier reaches every row on both removal paths (00071/00072) ─
--
-- The bare service-role key (CI, the REST smoke suite, an operator script) is
-- neither a user nor an API key, so both surfaces resolve `p_user_id => null`
-- for it — and on that connection `auth.uid()` is null too, so the actor these
-- RPCs derive is NULL and every `user_id = v_actor` disjunct is NULL. Pinning
-- that caller to its "own" rows therefore matched NOTHING: the natural-key
-- archive and the restore both came back 403 (`existed` true, nothing changed)
-- for the tier that holds the secret which can write the table directly.
--
-- §84/§85 pin the two KEY tiers (scoped and unscoped); this pins the one above
-- them. The complement — that a NON-service-role caller gains nothing from a
-- null/spoofed p_user_id — is 60a/60f and SAR-5/SAR-R5, all still in force.
insert into memories (user_id, scope, key, value) values
  ('00000000-0000-0000-0000-0000000000b2', 'project::svctier', 'svc-row', 'written by B');

do $$
declare
  r       record;
  v_count int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- (1) Archive another principal's row with NO p_user_id and NO key scoping —
  --     the exact call `handleRemove`'s natural-key branch makes for a
  --     service-token request.
  select * into r from memory_delete(
    p_user_id  => null,
    p_org_slug => null,
    p_scope    => 'project::svctier',
    p_key      => 'svc-row',
    p_force    => false);
  assert r.archived and r.existed and not r.deleted,
    format('SVC-1: the service tier must archive any row (archived=%s existed=%s deleted=%s)',
           r.archived, r.existed, r.deleted);
  select count(*) into v_count from memories
    where scope = 'project::svctier' and key = 'svc-row' and archived_at is not null;
  assert v_count = 1, 'SVC-1: the row must actually be archived';

  -- (2) …and restore it. A tier that can archive a row but not un-archive it is
  --     the asymmetry 00072 exists to close.
  select * into r from restore_memory(
    p_user_id => null,
    p_scope   => 'project::svctier',
    p_key     => 'svc-row');
  assert r.restored and r.existed,
    format('SVC-2: the service tier must restore the row it just archived (restored=%s existed=%s)',
           r.restored, r.existed);
  select count(*) into v_count from memories
    where scope = 'project::svctier' and key = 'svc-row' and archived_at is null;
  assert v_count = 1, 'SVC-2: the row must be live again';

  -- (3) …and hard-delete it.
  select * into r from memory_delete(
    p_user_id  => null,
    p_org_slug => null,
    p_scope    => 'project::svctier',
    p_key      => 'svc-row',
    p_force    => true);
  assert r.deleted and not r.archived,
    format('SVC-3: the service tier must hard-delete any row (deleted=%s archived=%s)',
           r.deleted, r.archived);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from memories where scope = 'project::svctier';
  assert v_count = 0, 'SVC-3: the row must be physically gone';
end;
$$;

-- ── 00074: query-profiling reader is bounded and operator-only ──────────────
-- `lorekit_db_query_stats()` reads pg_stat_statements — the whole cluster's
-- query shapes, every tenant's workload aggregated. Two properties matter and
-- neither is visible from the app layer: it must be unreachable by `anon` and
-- `authenticated` (PostgREST exposes ANY function they can execute, so a missing
-- revoke silently publishes a cross-tenant view), and it must never raise, since
-- an observability read that can fail is a request that can fail.
do $$
declare
  v_count  int;
  v_rows   int;
  v_status text;
begin
  -- (1) The function exists with the expected arity, and is SECURITY DEFINER.
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'lorekit_db_query_stats' and p.prosecdef;
  assert v_count = 1,
    format('PROF-1: lorekit_db_query_stats must exist exactly once as SECURITY DEFINER (found %s)', v_count);

  -- (2) NOT executable by the two PostgREST-facing roles. `create function`
  --     grants EXECUTE to PUBLIC by default, so this asserts the revoke landed
  --     rather than asserting a default.
  assert not has_function_privilege('anon', 'lorekit_db_query_stats(integer)', 'execute'),
    'PROF-2: anon must NOT be able to execute lorekit_db_query_stats';
  assert not has_function_privilege('authenticated', 'lorekit_db_query_stats(integer)', 'execute'),
    'PROF-2: authenticated must NOT be able to execute lorekit_db_query_stats';
  assert has_function_privilege('service_role', 'lorekit_db_query_stats(integer)', 'execute'),
    'PROF-2: service_role MUST be able to execute lorekit_db_query_stats';

  -- (3) It returns without raising whether or not pg_stat_statements is
  --     installed. On a local stack the extension is usually absent, which is
  --     precisely the path that must yield zero rows instead of an error — the
  --     dynamic-SQL + exception guard in 00074.
  select count(*) into v_rows from lorekit_db_query_stats(5);
  assert v_rows >= 0, 'PROF-3: the reader must return a row count, not raise';

  -- (4) The row cap is enforced INSIDE the function, so a caller cannot ask for
  --     unbounded metric cardinality. Only assertable when the extension is
  --     present and actually has more rows than the cap.
  if exists (select 1 from pg_extension where extname = 'pg_stat_statements') then
    select count(*) into v_rows from lorekit_db_query_stats(1000);
    assert v_rows <= 200,
      format('PROF-4: p_limit must be capped at 200 regardless of the request (got %s rows)', v_rows);
    -- A null or absurd limit must not bypass the cap either.
    select count(*) into v_rows from lorekit_db_query_stats(null);
    assert v_rows <= 200, format('PROF-4: a null p_limit must fall back to the default (got %s rows)', v_rows);
  end if;

  -- (5) The scheduled exporter is inert until an operator provisions the two
  --     Vault secrets. This asserts the OFF-BY-DEFAULT posture: applying the
  --     migration must not start sending anything anywhere. Gated on the
  --     secrets actually being absent so the assertion states the real
  --     invariant ("no secrets ⇒ no post") rather than assuming the
  --     environment it runs in.
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from vault.decrypted_secrets
                     where name in ('lorekit_profiling_url', 'lorekit_profiling_key'))
  then
    select lorekit_export_db_query_stats() into v_status;
    assert v_status ~ '^(disabled|skipped)',
      format('PROF-5: the exporter must be inert without vault secrets, got %s', v_status);
  end if;

  assert not has_function_privilege('anon', 'lorekit_export_db_query_stats()', 'execute'),
    'PROF-5: anon must NOT be able to trigger the exporter';
  assert not has_function_privilege('authenticated', 'lorekit_export_db_query_stats()', 'execute'),
    'PROF-5: authenticated must NOT be able to trigger the exporter';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- §86 — the MCP org tools under an api_key actor override
-- ═════════════════════════════════════════════════════════════════════════
-- The MCP `org.*` tools were JWT-only: their RPCs resolve the actor from
-- `auth.uid()`, and the api_key tier reaches Postgres over a service-role
-- connection where that is NULL, so every `lorekit_org_can(...)` denied. They
-- now pass the token owner explicitly as `p_actor_user_id`, the same path
-- `supabase/functions/orgs/` has used since 00041.
--
-- §50–§59 already prove the override itself. What this pins is the pair of
-- properties the MCP surface newly depends on, and would break silently:
--
--   (1) the override is HONOURED on a service-role connection, so an api_key
--       caller can act as its own token owner; and
--   (2) it does NOT become an impersonation primitive — token permission is
--       orthogonal to org ROLE, so an actor who is only a viewer is still
--       denied a rename with LK002.
--
-- (2) is the one worth the test. Token permission is checked at the edge, org
-- role only in the RPC, so a `lk_rw_*` token held by a viewer passes every
-- check the edge can make. If the RPC's role gate ever stopped applying to the
-- overridden actor, that token would silently gain admin powers.
do $$
declare
  v_owner  uuid := '00000000-0000-0000-0000-0000000086a1';
  v_viewer uuid := '00000000-0000-0000-0000-0000000086b2';
  v_org    uuid;
  v_name   text;
  v_count  int;
  v_denied_viewer_rename boolean := false;
  v_denied_viewer_delete boolean := false;
  v_denied_null_actor    boolean := false;
begin
  insert into auth.users (id, email) values
    (v_owner,  'org86-owner@test.local'),
    (v_viewer, 'org86-viewer@test.local')
  on conflict (id) do nothing;

  -- ── (1)+(2) create and rename, as a service-role caller naming its actor ──
  --
  -- BOTH lines below are required, and the second is the load-bearing one.
  -- `lorekit_org_actor` (00041) discriminates on `auth.role()`, which reads the
  -- `role` claim out of `request.jwt.claims` — NOT the Postgres session role.
  -- With only `set local role service_role`, the claim stays unset, auth.role()
  -- is not 'service_role', the override is IGNORED, and the actor falls back to
  -- a NULL auth.uid(). The first version of this section did exactly that and
  -- died on `org_actor_unresolved` — which was the override failing closed
  -- precisely as 00041 §4 designs it, so the harness was wrong, not the RPC.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select lorekit_org_create(
    p_slug          => 'org86',
    p_name          => 'Org 86',
    p_actor_user_id => v_owner) into v_org;

  perform lorekit_org_rename(
    p_org_id        => v_org,
    p_name          => 'Org 86 renamed',
    p_actor_user_id => v_owner);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_org is not null, '86-1: create must return the new org id';
  select count(*) into v_count from org_members
    where org_id = v_org and user_id = v_owner and role = 'owner';
  assert v_count = 1, '86-1: the named actor must become the owner, not auth.uid()';
  select name into v_name from orgs where id = v_org;
  assert v_name = 'Org 86 renamed',
    format('86-2: the owner must be able to rename (name=%s)', v_name);

  -- Fixture, not part of the scenario: `org_members` carries a SELECT policy
  -- and no INSERT policy at all (00022), so the viewer row is written here as
  -- the migration role rather than leaning on service_role's BYPASSRLS.
  insert into org_members (org_id, user_id, role) values (v_org, v_viewer, 'viewer')
    on conflict (org_id, user_id) do update set role = 'viewer';

  -- ── (3)(4)(5) the denials, and the owner's soft delete ───────────────────
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- (3) The load-bearing case. Nothing about holding a write-capable TOKEN
  -- grants an org role, and this is where that separation is enforced.
  --
  -- Each denial sets a flag and is asserted after the block rather than with an
  -- `assert false` inside the `begin`: `assert` raises P0004, which `when
  -- others` would catch and then re-report as "expected LK002, got <the
  -- assertion's own message>" — a failure, but one that names the wrong cause.
  begin
    perform lorekit_org_rename(
      p_org_id        => v_org,
      p_name          => 'Org 86 hijacked',
      p_actor_user_id => v_viewer);
  exception when sqlstate 'LK002' then v_denied_viewer_rename := true; end;

  -- (4) A NULL actor still fails closed — the property 00041 was written
  -- around: no actor, no authority. An edge bug that forgot to pass the token
  -- owner must deny rather than act as someone.
  --
  -- Ordered BEFORE the owner's delete deliberately, so the org is still live
  -- and the denial can only be the actor. `lorekit_org_rename` checks the
  -- capability first and has no deleted-org guard at all, so running this after
  -- the soft delete would still pass — while no longer proving what it claims.
  begin
    perform lorekit_org_rename(
      p_org_id        => v_org,
      p_name          => 'Org 86 nulled',
      p_actor_user_id => null);
  exception when sqlstate 'LK002' then v_denied_null_actor := true; end;

  -- (5) delete is owner-only, and a SOFT delete.
  begin
    perform lorekit_org_delete(p_org_id => v_org, p_actor_user_id => v_viewer);
  exception when sqlstate 'LK002' then v_denied_viewer_delete := true; end;

  perform lorekit_org_delete(p_org_id => v_org, p_actor_user_id => v_owner);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_denied_viewer_rename,
    '86-3: a viewer actor must be denied the rename with LK002';
  assert v_denied_null_actor,
    '86-4: a NULL actor must not be able to rename';
  assert v_denied_viewer_delete,
    '86-5: a viewer actor must be denied the delete with LK002';

  select name into v_name from orgs where id = v_org;
  assert v_name = 'Org 86 renamed',
    format('86-3/86-4: no denied rename may have taken effect (name=%s)', v_name);

  select count(*) into v_count from orgs where id = v_org and deleted_at is not null;
  assert v_count = 1,
    '86-5: the owner delete must SOFT-delete (deleted_at set), matching what the MCP tool advertises';
  select count(*) into v_count from orgs where id = v_org;
  assert v_count = 1, '86-5: the row must still exist — a purge is a separate, owner-only step';
end;
$$;

-- ── 88. Per-memory read counters + daily rollup (00077) ─────────────────────
-- usage_events records HOW MANY records a call touched, never WHICH -- there
-- is no memory_id on the read ledger and none of the 17 tables is a
-- per-memory read table. This closes it with counters + a daily rollup, not a
-- per-read event table.
-- AC-1: lorekit_record_memory_reads increments read_count/last_read_at for
--       EVERY id in the array, in one call.
-- AC-2: it upserts memory_read_daily, keyed by (memory_id, day, read_kind),
--       accumulating count across repeated calls on the same day.
-- AC-3: a null/empty array is a no-op -- no row touched, no error raised.
-- AC-4: the read_kind CHECK is a real backstop.
-- AC-5: ON DELETE CASCADE -- purging a memory removes its rollup rows; an
--       ARCHIVED memory (soft-delete only) keeps them.
do $$
declare
  v_m1        uuid;
  v_m2        uuid;
  v_read_count integer;
  v_last_read  timestamptz;
  v_rollup_count integer;
  v_rollup_rows  integer;
  v_raised       boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"service_role"}', true);

  insert into memories (user_id, scope, key, value)
    values ('00000000-0000-0000-0000-0000000000a1', 'global', '87-lesson-1', 'v')
    returning id into v_m1;
  insert into memories (user_id, scope, key, value)
    values ('00000000-0000-0000-0000-0000000000a1', 'global', '87-lesson-2', 'v')
    returning id into v_m2;

  -- AC-1: a bulk read over both memories, one call, one array.
  perform lorekit_record_memory_reads(array[v_m1, v_m2], 'bulk');

  select read_count, last_read_at into v_read_count, v_last_read from memories where id = v_m1;
  assert v_read_count = 1, format('88 AC-1: read_count must increment to 1, got %s', v_read_count);
  assert v_last_read is not null, '88 AC-1: last_read_at must be set';

  select read_count into v_read_count from memories where id = v_m2;
  assert v_read_count = 1, format('88 AC-1: the second id in the array must ALSO increment, got %s', v_read_count);

  -- AC-2: a second bulk call the SAME day accumulates onto the same rollup row
  -- rather than inserting a second one.
  perform lorekit_record_memory_reads(array[v_m1], 'bulk');
  perform lorekit_record_memory_reads(array[v_m1], 'targeted');

  select count into v_rollup_count from memory_read_daily
   where memory_id = v_m1 and day = (now() at time zone 'UTC')::date and read_kind = 'bulk';
  assert v_rollup_count = 2, format('88 AC-2: the bulk rollup must accumulate to 2, got %s', v_rollup_count);

  select count(*) into v_rollup_rows from memory_read_daily where memory_id = v_m1;
  assert v_rollup_rows = 2,
    format('88 AC-2: bulk and targeted must be SEPARATE rollup rows for the same day, got %s rows', v_rollup_rows);

  select read_count into v_read_count from memories where id = v_m1;
  assert v_read_count = 3, format('88 AC-2: read_count must reflect all three calls (1+1+1), got %s', v_read_count);

  -- AC-3: a null/empty array must not raise and must not touch any row.
  perform lorekit_record_memory_reads(null, 'bulk');
  perform lorekit_record_memory_reads(array[]::uuid[], 'bulk');
  select read_count into v_read_count from memories where id = v_m1;
  assert v_read_count = 3, format('88 AC-3: a null/empty array must be a no-op, got read_count=%s', v_read_count);

  -- AC-4: the read_kind CHECK is a real backstop, not decoration.
  begin
    insert into memory_read_daily (memory_id, day, read_kind, count) values (v_m1, current_date, 'skimmed', 1);
  exception when check_violation then
    v_raised := true;
  end;
  assert v_raised, '88 AC-4: an unrecognised read_kind must violate the CHECK';

  -- AC-5: hard-delete (purge) cascades; archive (soft-delete) does not touch
  -- the rollup at all. Test the CASCADE using m2 (already has a 'bulk' rollup
  -- row from AC-1's array[v_m1, v_m2] call above) — give it a second, 'targeted'
  -- row so the setup count reflects both.
  perform lorekit_record_memory_reads(array[v_m2], 'targeted');
  select count(*) into v_rollup_rows from memory_read_daily where memory_id = v_m2;
  assert v_rollup_rows = 2, '88 AC-5 setup: m2 must have exactly two rollup rows (bulk + targeted) before the delete';

  delete from memories where id = v_m2;
  select count(*) into v_rollup_rows from memory_read_daily where memory_id = v_m2;
  assert v_rollup_rows = 0,
    format('88 AC-5: deleting the memory must CASCADE its rollup rows, got %s remaining', v_rollup_rows);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;

\echo 'migrations.test.sql: all assertions passed'
