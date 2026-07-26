-- Org sharing Phase 3, migration 2 of 3: the membership-truth WRITE path.
--
-- Every state transition for orgs/org_members/org_invites goes through one of
-- the 10 SECURITY DEFINER RPCs below — never a direct RLS-gated table write
-- (org_invites/org_members/orgs carry no insert/update/delete RLS policy).
-- Two problems make direct writes unsafe here (see plan.md Decisions):
--
--   1. Owner-bootstrap: the FIRST membership row can't be gated by existing
--      membership, so a self-insert-as-owner RLS policy would let any
--      authenticated user seize any org by inserting an owner row for a slug
--      they don't own. lorekit_org_create sidesteps this by being the only
--      path that can ever insert the first owner, atomically with the org
--      row, bound to auth.uid().
--   2. Non-atomic accept: inserting the membership row and flipping the
--      invite's status are two statements; RLS-gated direct writes would
--      make that two round-trips (a TOCTOU window). The RPC does both in one
--      transaction.
--
-- Every RPC below resolves the actor as `auth.uid()` — NEVER a caller-passed
-- user-id parameter — because these are dashboard actions invoked under a
-- real Supabase user JWT session (unlike memory_write/memory_delete, which
-- take an explicit p_user_id because the edge api_key path calls them from a
-- service-role client with no session JWT of its own). This is the same
-- anti-forgery property Phase 2 relies on, applied at the call boundary
-- instead of via a parameter: no argument the caller supplies can name a
-- different identity than the one the JWT authenticated.
--
-- lorekit_org_can (00015) is extended with six management capabilities —
-- never a second matrix. It stays the SOLE role -> capability source; these
-- RPCs only add capability-independent INVARIANTS (last-owner protection,
-- admin-cannot-touch-owner-or-admin, invite-addressed-to-caller) that a
-- static role matrix cannot express, since they depend on the mutation's
-- specific target/state, not just the actor's role.
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
    when 'write'         then v_role in ('member', 'admin', 'owner')
    when 'archive'       then v_role in ('member', 'admin', 'owner')
    when 'restore'       then v_role in ('member', 'admin', 'owner')
    when 'hard_delete'   then v_role in ('admin', 'owner')
    when 'invite'        then v_role in ('admin', 'owner')
    when 'revoke_invite' then v_role in ('admin', 'owner')
    when 'remove_member' then v_role in ('admin', 'owner')
    when 'change_role'   then v_role in ('admin', 'owner')
    when 'rename_org'    then v_role in ('admin', 'owner')
    when 'delete_org'    then v_role = 'owner'
    else false
  end;
end;
$$;

-- ── 1. Org lifecycle ─────────────────────────────────────────────────────────

-- Creates the org AND the creator's owner membership atomically. No
-- capability check: this is the owner-bootstrap path — anyone authenticated
-- may create an org and becomes its sole owner. A duplicate slug surfaces
-- the orgs.slug unique_violation naturally.
create or replace function lorekit_org_create(p_slug text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := gen_random_uuid();
begin
  insert into orgs (id, slug, name, created_by)
  values (v_org_id, p_slug, p_name, auth.uid());

  insert into org_members (org_id, user_id, role)
  values (v_org_id, auth.uid(), 'owner');

  return v_org_id;
end;
$$;

grant execute on function lorekit_org_create(text, text) to authenticated, service_role;

create or replace function lorekit_org_rename(p_org_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'rename_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=rename_org', p_org_id);
  end if;

  update orgs set name = p_name where id = p_org_id;
end;
$$;

grant execute on function lorekit_org_rename(uuid, text) to authenticated, service_role;

-- Owner-only. Cascades org_members/org_invites via their `on delete cascade`
-- FKs to orgs(id) — no manual cleanup needed.
create or replace function lorekit_org_delete(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'delete_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=delete_org', p_org_id);
  end if;

  delete from orgs where id = p_org_id;
end;
$$;

grant execute on function lorekit_org_delete(uuid) to authenticated, service_role;

-- ── 2. Invite lifecycle ──────────────────────────────────────────────────────

-- Shared identity-match check for accept/decline: true iff the invite is
-- addressed to the CALLER's verified JWT identity (email or GitHub handle).
-- Each comparison is explicitly `coalesce`d to false — `NULL = x` evaluates
-- to SQL NULL, not false, so a one-sided invite (email set, handle NULL, or
-- vice versa) would otherwise poison the `or` into NULL. `if not (NULL)` is
-- treated as `if not false` by plpgsql (the branch is skipped, no exception
-- raised) — a real privilege-escalation bug this coalesce closes, caught by
-- migrations.test.sql's AC-6 "wrong user accepts" negative assertion.
create or replace function lorekit_invite_addressed_to_caller(p_invite org_invites)
returns boolean
language sql
stable
as $$
  select
    coalesce(p_invite.invitee_email = lower(auth.jwt() ->> 'email'), false)
    or coalesce(p_invite.invitee_handle = lower(auth.jwt() -> 'user_metadata' ->> 'user_name'), false);
$$;

-- Owner/admin only. The org_invites.role CHECK (00019) independently rejects
-- an attempt to invite an 'owner' — this RPC does not re-derive that guard.
create or replace function lorekit_org_invite(
  p_org_id uuid,
  p_invitee_email text default null,
  p_invitee_handle text default null,
  p_role text default 'member'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite_id uuid;
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'invite') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=invite', p_org_id);
  end if;

  insert into org_invites (org_id, invitee_email, invitee_handle, role, invited_by)
  values (
    p_org_id,
    case when p_invitee_email is not null then lower(p_invitee_email) end,
    case when p_invitee_handle is not null then lower(p_invitee_handle) end,
    p_role,
    auth.uid()
  )
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

grant execute on function lorekit_org_invite(uuid, text, text, text) to authenticated, service_role;

create or replace function lorekit_org_invite_revoke(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv org_invites;
begin
  select * into inv from org_invites where id = p_invite_id;
  if inv.id is null then
    raise exception using errcode = 'LK002', message = 'invite not found';
  end if;

  if not lorekit_org_can(auth.uid(), inv.org_id, 'revoke_invite') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=revoke_invite', inv.org_id);
  end if;

  update org_invites set status = 'revoked', responded_at = now() where id = p_invite_id;
end;
$$;

grant execute on function lorekit_org_invite_revoke(uuid) to authenticated, service_role;

-- Binds the new membership row to the CALLER (auth.uid()), NEVER the invited
-- string. Takes no user-id parameter by design (the anti-TOCTOU fix — see
-- plan.md). The invited email/handle is only ever a MATCH TARGET for "is this
-- invite addressed to me?", never the identity that gets inserted.
create or replace function lorekit_org_invite_accept(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv org_invites;
begin
  select * into inv from org_invites where id = p_invite_id;
  if inv.id is null or inv.status <> 'pending'
     or (inv.expires_at is not null and inv.expires_at < now()) then
    raise exception using errcode = 'LK002', message = 'invite is not open';
  end if;

  if not lorekit_invite_addressed_to_caller(inv) then
    raise exception using errcode = 'LK002', message = 'invite is not addressed to you';
  end if;

  insert into org_members (org_id, user_id, role)
  values (inv.org_id, auth.uid(), inv.role)
  on conflict (org_id, user_id) do nothing;

  update org_invites set status = 'accepted', responded_at = now() where id = inv.id;
end;
$$;

grant execute on function lorekit_org_invite_accept(uuid) to authenticated, service_role;

-- Invitee-only. Mirrors the accept RPC's identity check but flips status to
-- 'declined' and creates no membership.
create or replace function lorekit_org_invite_decline(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv org_invites;
begin
  select * into inv from org_invites where id = p_invite_id;
  if inv.id is null or inv.status <> 'pending' then
    raise exception using errcode = 'LK002', message = 'invite is not open';
  end if;

  if not lorekit_invite_addressed_to_caller(inv) then
    raise exception using errcode = 'LK002', message = 'invite is not addressed to you';
  end if;

  update org_invites set status = 'declined', responded_at = now() where id = inv.id;
end;
$$;

grant execute on function lorekit_org_invite_decline(uuid) to authenticated, service_role;

-- ── 3. Member management ─────────────────────────────────────────────────────

-- Owner/admin only, plus two invariants a static role matrix cannot express:
--   - an admin actor may only act on member/viewer targets (never owner/admin)
--   - the last remaining owner can never be removed
create or replace function lorekit_org_member_remove(p_org_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role  text;
  v_target_role text;
  v_owner_count int;
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'remove_member') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=remove_member', p_org_id);
  end if;

  v_actor_role  := lorekit_org_role(auth.uid(), p_org_id);
  v_target_role := lorekit_org_role(p_target_user_id, p_org_id);

  if v_target_role is null then
    raise exception using errcode = 'LK002', message = 'target is not a member of this org';
  end if;

  if v_actor_role = 'admin' and v_target_role in ('owner', 'admin') then
    raise exception using errcode = 'LK002', message = 'an admin cannot remove an owner or another admin';
  end if;

  if v_target_role = 'owner' then
    select count(*) into v_owner_count from org_members where org_id = p_org_id and role = 'owner';
    if v_owner_count <= 1 then
      raise exception using errcode = 'LK002', message = 'the last owner cannot be removed — transfer or delete the org first';
    end if;
  end if;

  delete from org_members where org_id = p_org_id and user_id = p_target_user_id;
end;
$$;

grant execute on function lorekit_org_member_remove(uuid, uuid) to authenticated, service_role;

-- Owner/admin only. Cannot assign 'owner' (ownership is non-transferable in
-- v1); cannot demote the last owner; an admin actor may only act on
-- member/viewer targets, mirroring lorekit_org_member_remove's invariant.
create or replace function lorekit_org_member_role(p_org_id uuid, p_target_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role  text;
  v_target_role text;
  v_owner_count int;
begin
  if p_role = 'owner' then
    raise exception using errcode = 'LK002', message = 'cannot assign owner via changeMemberRole — ownership is not transferable in v1';
  end if;

  if not lorekit_org_can(auth.uid(), p_org_id, 'change_role') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=change_role', p_org_id);
  end if;

  v_actor_role  := lorekit_org_role(auth.uid(), p_org_id);
  v_target_role := lorekit_org_role(p_target_user_id, p_org_id);

  if v_target_role is null then
    raise exception using errcode = 'LK002', message = 'target is not a member of this org';
  end if;

  if v_actor_role = 'admin' and v_target_role in ('owner', 'admin') then
    raise exception using errcode = 'LK002', message = 'an admin cannot change the role of an owner or another admin';
  end if;

  if v_target_role = 'owner' then
    select count(*) into v_owner_count from org_members where org_id = p_org_id and role = 'owner';
    if v_owner_count <= 1 then
      raise exception using errcode = 'LK002', message = 'the last owner cannot be demoted — transfer or delete the org first';
    end if;
  end if;

  update org_members set role = p_role where org_id = p_org_id and user_id = p_target_user_id;
end;
$$;

grant execute on function lorekit_org_member_role(uuid, uuid, text) to authenticated, service_role;

-- Self-service: any member may remove their OWN membership (no capability
-- check — leaving is not a management action), except the last owner, who
-- must transfer ownership or delete the org first.
create or replace function lorekit_org_leave(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := lorekit_org_role(auth.uid(), p_org_id);
  v_owner_count int;
begin
  if v_role is null then
    raise exception using errcode = 'LK002', message = 'you are not a member of this org';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owner_count from org_members where org_id = p_org_id and role = 'owner';
    if v_owner_count <= 1 then
      raise exception using errcode = 'LK002', message = 'the last owner cannot leave — transfer or delete the org first';
    end if;
  end if;

  delete from org_members where org_id = p_org_id and user_id = auth.uid();
end;
$$;

grant execute on function lorekit_org_leave(uuid) to authenticated, service_role;
