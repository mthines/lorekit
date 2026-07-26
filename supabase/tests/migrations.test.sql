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
-- Phase 4 dashboard-UX addition — supabase/migrations/00022 (reverses
-- plan.md org-sharing-phase-4-dashboard Decision D1: real member identities
-- instead of a bare user_id for other members).
-- ═════════════════════════════════════════════════════════════════════════

-- ── 30. lorekit_org_members_list: member sees co-members' real handles;
--       non-member sees nothing (Phase 4 addition, 00022) ────────────────────
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

rollback;

\echo 'migrations.test.sql: all assertions passed'
