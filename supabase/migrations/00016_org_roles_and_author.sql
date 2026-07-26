-- Org write foundations, part 1: a `viewer` role and author attribution.
--
-- Phase 2 (org-owned writes) opens the write path Phase 1 deliberately left
-- closed. This migration lays the two pieces the write/delete RPCs (00017,
-- 00018) depend on:
--
--   1. `viewer` joins the `org_members.role` CHECK. Phase 1 only ever needed
--      owner/admin/member (nobody could write yet); Phase 2 needs a
--      read-only role so "a viewer cannot write/delete" is expressible.
--   2. `created_by` / `updated_by` land on `memories`, additive and nullable,
--      neighbour-symmetric with the existing `created_at`/`updated_at` pair
--      (created_by preserved on clobber like created_at; updated_by tracks
--      the last writer like updated_at tracks the last write time). Org rows
--      keep `user_id NULL` (see 00013/00014) so a dedicated author pair
--      records who wrote an org row without overloading `user_id` — reusing
--      `user_id` would pool org rows into the writer's personal cap count
--      and personal RLS partition.
--
-- `lorekit_org_role` / `lorekit_org_can` are the single SQL capability
-- source (mirrors the `lorekit_member_org_ids` SECURITY DEFINER shape,
-- 00012_orgs.sql): every role -> capability decision for org writes/deletes
-- routes through `lorekit_org_can`, never a hand-copied TS matrix. Reads are
-- untouched — `lorekit_member_org_ids` stays the sole read-visibility
-- predicate (R8).

alter table org_members drop constraint org_members_role_check;
alter table org_members add constraint org_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer'));

alter table memories
  add column if not exists created_by uuid references auth.users on delete set null,
  add column if not exists updated_by uuid references auth.users on delete set null;

-- Resolve a user's role within an org, or NULL if they are not a member.
-- STABLE (read-only within a statement) + SECURITY DEFINER so it can be
-- called from the memory_write/memory_delete RPCs (also SECURITY DEFINER)
-- regardless of the caller's RLS visibility into org_members.
create or replace function lorekit_org_role(p_user_id uuid, p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from org_members where user_id = p_user_id and org_id = p_org_id;
$$;

grant execute on function lorekit_org_role(uuid, uuid) to anon, authenticated, service_role;

-- The single capability source for org write/delete authorization.
-- Capabilities: 'write' | 'archive' | 'restore' | 'hard_delete'.
-- Matrix: viewer -> none; member -> write/archive/restore; admin & owner ->
-- additionally hard_delete. A non-member (NULL role) is denied everything.
-- This is the ONLY place the role -> capability matrix is encoded — the
-- app-layer org-permissions.ts module translates the resulting LK002 denial,
-- it does not re-derive the matrix (see plan.md Decisions).
create or replace function lorekit_org_can(p_user_id uuid, p_org_id uuid, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := lorekit_org_role(p_user_id, p_org_id);
begin
  if v_role is null then
    return false;
  end if;

  return case p_capability
    when 'write'       then v_role in ('member', 'admin', 'owner')
    when 'archive'     then v_role in ('member', 'admin', 'owner')
    when 'restore'     then v_role in ('member', 'admin', 'owner')
    when 'hard_delete' then v_role in ('admin', 'owner')
    else false
  end;
end;
$$;

grant execute on function lorekit_org_can(uuid, uuid, text) to anon, authenticated, service_role;
