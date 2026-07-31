-- ═════════════════════════════════════════════════════════════════════════
-- Org actor override — let the REST edge functions serve `lk_*` API tokens.
--
-- ── The problem ──────────────────────────────────────────────────────────
-- Every org management RPC (00022, plus the 00024/00025 re-definitions)
-- resolves the acting user as `auth.uid()`. That is exactly right for the
-- dashboard, which calls them under a real Supabase user JWT session.
--
-- It is unusable for `supabase/functions/orgs/`'s `api_key` auth tier. A
-- `lk_rw_*` / `lk_ro_*` token is verified by the edge function itself
-- (SHA-256 lookup in `api_tokens`), after which the function talks to
-- Postgres with the SERVICE-ROLE key. There is no end-user JWT on that
-- connection, so `auth.uid()` is NULL and every `lorekit_org_can(...)`
-- check denies. The practical consequence today is that `GET/POST/PATCH/
-- DELETE /orgs*` are registered `requires: 'jwt'` and API tokens get a 403 —
-- which is why the CLI still has to keep an MCP transport alive purely for
-- `org.create` / `org.list` / `org.rename` / `org.delete`.
--
-- ── The fix, and why it is the precedent already in this repo ────────────
-- `memory_write` (00019) and `memory_delete` (00020) hit the same wall in
-- Phase 2 and solved it the same way: take the actor as an explicit
-- parameter, because the edge api_key path calls from a service-role client
-- with no session JWT of its own. 00022's header comment names that
-- distinction explicitly. This migration extends the same treatment to the
-- org-management RPCs the REST surface actually exposes.
--
-- ── THE SECURITY INVARIANT ───────────────────────────────────────────────
-- `p_actor_user_id` is NOT a "who am I" parameter. It is a privileged
-- override that only a service-role connection can exercise:
--
--     lorekit_org_actor(p_actor_user_id) =
--       auth.role() = 'service_role'  ->  coalesce(p_actor_user_id, auth.uid())
--       otherwise                     ->  auth.uid()
--
-- 1. AN `authenticated` CALLER'S `p_actor_user_id` IS IGNORED, ENTIRELY.
--    If you are `authenticated`, the parameter never reaches the result: the
--    `else` branch returns `auth.uid()` and nothing else. A dashboard user
--    (or anyone who obtains an anon-key + user JWT and calls PostgREST
--    directly) can pass any UUID they like — their own, an owner's, a
--    stranger's — and still acts as themselves. There is no combination of
--    request input that changes this, because the discriminator is not
--    request input.
--
-- 2. THE DISCRIMINATOR IS A VERIFIED JWT CLAIM, NOT A REQUEST FIELD.
--    `auth.role()` reads the `role` claim out of `request.jwt.claims`, which
--    PostgREST sets from the JWT it has already cryptographically VERIFIED
--    against the project's JWT secret. A client cannot set it: it is not a
--    header, a query parameter, or a body field, and forging it requires the
--    signing secret. This is the SAME predicate `rls_insert` (00001) has
--    relied on since the first migration to grant service-role a bypass, and
--    the same one `lorekit_memory_scopes` (00039) uses for its CI escape
--    hatch. It is not a new trust assumption — it is the existing one.
--
-- 3. WHO ACTUALLY HOLDS SERVICE-ROLE. Only `SUPABASE_SERVICE_ROLE_KEY`
--    produces that claim, and it lives exclusively in server-side secrets
--    (the edge functions, CI). The edge function does not take the actor
--    from the request either: it resolves it from the `api_tokens` row it
--    just authenticated by token hash (`resolveRestAuth` ->
--    `auth.userId` -> `actorUserId(auth)`). So the chain is
--    "presented token -> hashed -> matched row -> that row's owner", never
--    "caller said so". A client with a `lk_*` token can only ever act as the
--    user that token belongs to.
--
-- 4. IT FAILS CLOSED. When the actor resolves to NULL (service-role with no
--    override and no `sub` claim), every capability check becomes
--    `lorekit_org_can(null, ...)`, whose `lorekit_org_role(null, ...)` is
--    NULL, whose `if v_role is null then return false` denies everything.
--    The one RPC with no capability check — `lorekit_org_create`, the
--    owner-bootstrap path — therefore gains an EXPLICIT null-actor guard
--    below; without it a service-role call with no actor would insert an org
--    with a NULL `created_by` (and then fail confusingly on the NOT NULL
--    `org_members.user_id`).
--
-- 5. IT IS BACKWARD COMPATIBLE. The new parameter is TRAILING and DEFAULTS
--    to NULL, and PostgREST resolves overloads by named arguments, so every
--    existing caller that omits it — all of `packages/web/src/lib/orgs.ts`,
--    `org-invites.ts`, `org-members.ts`, and the MCP `org.*` tools in
--    `supabase/functions/mcp/tools.ts` — keeps working unchanged and keeps
--    resolving its actor from `auth.uid()`.
--
-- ── Deliberately NOT changed: accept / decline / leave ───────────────────
-- `lorekit_org_invite_accept`, `lorekit_org_invite_decline` and
-- `lorekit_org_leave` keep their pure `auth.uid()` actor and gain no
-- override. They are not REST routes, so nothing needs it yet, and for
-- accept/decline it would be actively unsafe to bolt on: they do not merely
-- resolve an actor, they MATCH the invite's `invitee_email` /
-- `invitee_handle` against the caller's VERIFIED JWT identity claims
-- (`email`, `user_metadata.user_name`) via `lorekit_invite_addressed_to_caller`
-- (00022). A service-role connection carries no such claims, so an override
-- would have to also invent an identity to match against — i.e. re-derive
-- the anti-TOCTOU check that is the whole point of that RPC. Giving
-- service-role an identity source it can trust is a separate change with its
-- own threat model. `lorekit_org_leave` is left alone for consistency with
-- them and because `DELETE /orgs/:slug/members/:userId`'s self-removal branch
-- is the only caller; under an api_key token that branch now fails closed
-- with LK002 ("you are not a member of this org") rather than silently
-- removing the wrong row. Documented as a known gap, not an accident.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 0. The actor resolver ────────────────────────────────────────────────
-- SECURITY DEFINER + STABLE, mirroring the shape of every other resolver in
-- this schema (`lorekit_org_role`, `lorekit_member_org_ids`). `stable` is
-- correct: it reads only session settings, which do not change within a
-- statement.
create or replace function lorekit_org_actor(p_actor_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'service_role' then coalesce(p_actor_user_id, auth.uid())
    else auth.uid()
  end;
$$;

-- No `anon` grant. The function returns only the caller's own resolved
-- identity (or NULL), so it leaks nothing, but there is no reason for an
-- unauthenticated role to call it — same posture as `lorekit_member_org_ids`.
grant execute on function lorekit_org_actor(uuid) to authenticated, service_role;

comment on function lorekit_org_actor(uuid) is
  'Resolves the acting user for an org RPC. Returns auth.uid() for every caller '
  'except a verified service_role JWT, which may name an actor explicitly. An '
  'authenticated caller''s p_actor_user_id is always ignored.';

-- ── 1. Org lifecycle ─────────────────────────────────────────────────────

-- Bodies below are copied VERBATIM from the migration that last defined each
-- function — 00022 for create/rename/invite/invite_revoke/member_remove/
-- member_role, 00025 for delete (the soft-delete rewrite), 00024 for
-- members_list — with exactly one class of change: `auth.uid()` becomes
-- `v_actor`, resolved once at the top from `lorekit_org_actor(...)`. Starting
-- from 00022 for `delete`/`members_list` would silently revert the
-- soft-delete and the identity-resolving member list.
--
-- Each function is DROPPED first rather than `create or replace`d: adding a
-- parameter creates a new OVERLOAD instead of replacing, and two overloads
-- that differ only by a defaulted trailing argument make a named-argument
-- PostgREST call ambiguous. Dropping also drops the grants, so every one is
-- re-issued below, identical to the original.

drop function if exists lorekit_org_create(text, text);

-- Creates the org AND the creator's owner membership atomically. No
-- capability check: this is the owner-bootstrap path — anyone authenticated
-- may create an org and becomes its sole owner. A duplicate slug surfaces
-- the orgs.slug unique_violation naturally.
--
-- Unlike every sibling below, this RPC has no `lorekit_org_can` gate to fail
-- closed on a NULL actor, so it needs its OWN explicit guard (invariant 4 in
-- the header). LK002 is reused deliberately: `translateDbError` already maps
-- it to a 403, which is the honest answer to "service-role called this with
-- nobody to own the result".
create or replace function lorekit_org_create(
  p_slug text,
  p_name text,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := lorekit_org_actor(p_actor_user_id);
  v_org_id uuid := gen_random_uuid();
begin
  if v_actor is null then
    raise exception using errcode = 'LK002', message = 'org_actor_unresolved: lorekit_org_create requires an actor (an authenticated session, or an explicit p_actor_user_id from service_role)';
  end if;

  insert into orgs (id, slug, name, created_by)
  values (v_org_id, p_slug, p_name, v_actor);

  insert into org_members (org_id, user_id, role)
  values (v_org_id, v_actor, 'owner');

  return v_org_id;
end;
$$;

grant execute on function lorekit_org_create(text, text, uuid) to authenticated, service_role;

drop function if exists lorekit_org_rename(uuid, text);

create or replace function lorekit_org_rename(
  p_org_id uuid,
  p_name text,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := lorekit_org_actor(p_actor_user_id);
begin
  if not lorekit_org_can(v_actor, p_org_id, 'rename_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=rename_org', p_org_id);
  end if;

  update orgs set name = p_name where id = p_org_id;
end;
$$;

grant execute on function lorekit_org_rename(uuid, text, uuid) to authenticated, service_role;

drop function if exists lorekit_org_delete(uuid);

-- Body from 00025 (the SOFT delete), not 00022 (which really deleted the
-- row). Owner-only. Idempotent: a second call on an already-soft-deleted org
-- is a no-op via the `deleted_at is null` guard.
create or replace function lorekit_org_delete(
  p_org_id uuid,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := lorekit_org_actor(p_actor_user_id);
begin
  if not lorekit_org_can(v_actor, p_org_id, 'delete_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=delete_org', p_org_id);
  end if;

  update orgs set deleted_at = now() where id = p_org_id and deleted_at is null;
end;
$$;

grant execute on function lorekit_org_delete(uuid, uuid) to authenticated, service_role;

-- ── 2. Invite lifecycle ──────────────────────────────────────────────────
-- `lorekit_invite_addressed_to_caller` is untouched, as are
-- `lorekit_org_invite_accept` / `_decline` (see the header).

drop function if exists lorekit_org_invite(uuid, text, text, text);

-- Owner/admin only. The org_invites.role CHECK (00021) independently rejects
-- an attempt to invite an 'owner' — this RPC does not re-derive that guard.
create or replace function lorekit_org_invite(
  p_org_id uuid,
  p_invitee_email text default null,
  p_invitee_handle text default null,
  p_role text default 'member',
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := lorekit_org_actor(p_actor_user_id);
  v_invite_id uuid;
begin
  if not lorekit_org_can(v_actor, p_org_id, 'invite') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=invite', p_org_id);
  end if;

  insert into org_invites (org_id, invitee_email, invitee_handle, role, invited_by)
  values (
    p_org_id,
    case when p_invitee_email is not null then lower(p_invitee_email) end,
    case when p_invitee_handle is not null then lower(p_invitee_handle) end,
    p_role,
    v_actor
  )
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

grant execute on function lorekit_org_invite(uuid, text, text, text, uuid) to authenticated, service_role;

drop function if exists lorekit_org_invite_revoke(uuid);

create or replace function lorekit_org_invite_revoke(
  p_invite_id uuid,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := lorekit_org_actor(p_actor_user_id);
  inv org_invites;
begin
  select * into inv from org_invites where id = p_invite_id;
  if inv.id is null then
    raise exception using errcode = 'LK002', message = 'invite not found';
  end if;

  if not lorekit_org_can(v_actor, inv.org_id, 'revoke_invite') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=revoke_invite', inv.org_id);
  end if;

  -- Only a still-pending invite can be revoked — guards the silent
  -- re-revoke and the revoke-of-already-accepted cases (accepted invites are
  -- undone via member removal, not revoke).
  if inv.status <> 'pending' then
    raise exception using errcode = 'LK002', message = 'invite is not pending';
  end if;

  update org_invites set status = 'revoked', responded_at = now() where id = p_invite_id;
end;
$$;

grant execute on function lorekit_org_invite_revoke(uuid, uuid) to authenticated, service_role;

-- ── 3. Member management ─────────────────────────────────────────────────

drop function if exists lorekit_org_member_remove(uuid, uuid);

-- Owner/admin only, plus two invariants a static role matrix cannot express:
--   - an admin actor may only act on member/viewer targets (never owner/admin)
--   - the last remaining owner can never be removed
create or replace function lorekit_org_member_remove(
  p_org_id uuid,
  p_target_user_id uuid,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := lorekit_org_actor(p_actor_user_id);
  v_actor_role  text;
  v_target_role text;
  v_owner_count int;
begin
  if not lorekit_org_can(v_actor, p_org_id, 'remove_member') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=remove_member', p_org_id);
  end if;

  v_actor_role  := lorekit_org_role(v_actor, p_org_id);
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

grant execute on function lorekit_org_member_remove(uuid, uuid, uuid) to authenticated, service_role;

drop function if exists lorekit_org_member_role(uuid, uuid, text);

-- Owner/admin only. Cannot assign 'owner' (ownership is non-transferable in
-- v1); cannot demote the last owner; an admin actor may only act on
-- member/viewer targets, mirroring lorekit_org_member_remove's invariant.
create or replace function lorekit_org_member_role(
  p_org_id uuid,
  p_target_user_id uuid,
  p_role text,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := lorekit_org_actor(p_actor_user_id);
  v_actor_role  text;
  v_target_role text;
  v_owner_count int;
begin
  if p_role = 'owner' then
    raise exception using errcode = 'LK002', message = 'cannot assign owner via changeMemberRole — ownership is not transferable in v1';
  end if;

  if not lorekit_org_can(v_actor, p_org_id, 'change_role') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=change_role', p_org_id);
  end if;

  v_actor_role  := lorekit_org_role(v_actor, p_org_id);
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

grant execute on function lorekit_org_member_role(uuid, uuid, text, uuid) to authenticated, service_role;

-- ── 4. Member identity listing (read) ────────────────────────────────────

drop function if exists lorekit_org_members_list(uuid);

-- Body from 00024. Membership-gated PII read: a caller may resolve the
-- handle/avatar of anyone who shares an org WITH them, and only for that org.
-- A non-member (or a non-existent org — `lorekit_org_role` is NULL either
-- way) gets an EMPTY set, never an error, so existence is never leaked. A
-- service-role call with no actor therefore also gets an empty set: this
-- read fails closed exactly like the write RPCs, without a special case.
create or replace function lorekit_org_members_list(
  p_org_id uuid,
  p_actor_user_id uuid default null
)
returns table (
  user_id    uuid,
  handle     text,
  avatar_url text,
  role       text,
  joined_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := lorekit_org_actor(p_actor_user_id);
begin
  if lorekit_org_role(v_actor, p_org_id) is null then
    return;
  end if;

  return query
    select
      m.user_id,
      coalesce(
        u.raw_user_meta_data ->> 'user_name',
        u.raw_user_meta_data ->> 'preferred_username'
      ) as handle,
      u.raw_user_meta_data ->> 'avatar_url' as avatar_url,
      m.role,
      m.created_at as joined_at
    from org_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = p_org_id
    order by m.created_at asc;
end;
$$;

-- No `anon` grant (unlike lorekit_member_org_ids/lorekit_org_role, which
-- return only booleans/ids): this function returns PII (handle, avatar_url)
-- for other users, so it is authenticated-only, defense in depth beyond the
-- membership gate above.
grant execute on function lorekit_org_members_list(uuid, uuid) to authenticated, service_role;
