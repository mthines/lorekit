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
-- AC-8: Rows come back sorted by scope ascending.

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

  -- AC-8: results are ordered by scope ascending.
  select array_agg(scope) into v_scopes from lorekit_memory_scopes('00000000-0000-0000-0000-0000000000a1');
  select array_agg(s order by s) into v_sorted from unnest(v_scopes) as s;
  assert v_scopes = v_sorted,
    format('memory scopes AC-8: results must be sorted by scope asc, got %s', v_scopes);

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
  v_rest_id     uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);

  select purge_archived_memories('00000000-0000-0000-0000-0000000000d4', 0) into v_purged_arch;
  select purge_expired_memories('00000000-0000-0000-0000-0000000000d4')     into v_purged_exp;
  select archive_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-active')   into v_arch_id;
  select restore_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-archived') into v_rest_id;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_purged_arch = 0,
    format('IDOR: e5 hard-deleted %s of d4''s archived rows by naming d4 as p_user_id', v_purged_arch);
  assert v_purged_exp = 0,
    format('IDOR: e5 hard-deleted %s of d4''s expired rows by naming d4 as p_user_id', v_purged_exp);
  assert v_arch_id is null,
    'IDOR: e5 archived one of d4''s rows by naming d4 as p_user_id';
  assert v_rest_id is null,
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
  v_rest_id    uuid;
  v_purged_exp int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);

  select archive_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-active')   into v_arch_id;
  select restore_memory('00000000-0000-0000-0000-0000000000d4', 'project::actor-guard-mig', 'ag-archived') into v_rest_id;
  select purge_expired_memories('00000000-0000-0000-0000-0000000000d4') into v_purged_exp;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_arch_id is not null, 'self-service: d4 archiving its OWN active row must succeed';
  assert v_rest_id is not null, 'self-service: d4 restoring its OWN archived row must succeed';
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
    'restore_memory(uuid, text, text)',
    'purge_archived_memories(uuid, integer)',
    'purge_expired_memories(uuid)',
    'memory_delete(uuid, text, text, text, boolean)'
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
    'lorekit_memory_scopes(uuid)',
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
  v_sig text := 'memory_write(uuid, text, text, text, text[], text, text, timestamp with time zone, text, integer, boolean, text, text, text, integer, text, text)';
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

-- ── 70. lorekit_memory_facets grant surface — PII-adjacent, so no anon ──────
-- Branch names, repo names and agent names are at least as sensitive as the
-- scope names 00039 withholds, so the grant set is that function's verbatim.
do $$
declare
  -- 00057 widened the signature with the drill-down filter params (19 args).
  v_sig text := 'lorekit_memory_facets(uuid, boolean, text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text)';
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

rollback;

\echo 'migrations.test.sql: all assertions passed'
