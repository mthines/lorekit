-- Org sharing Phase 4 addition: real member identities for the dashboard
-- member list. This REVERSES plan.md Decision D1's "web-only, no handle
-- resolution for other members" deferral — an explicit orchestrator override
-- of the Phase 4 dashboard-UX plan (see
-- .agent/claude/org-sharing-phase-4-dashboard/plan.md Decisions, D1).
--
-- `org_members` exposes only `user_id`. `auth.users.raw_user_meta_data`
-- (GitHub OAuth: `user_name` + `avatar_url` — the SAME claims 00019/00020
-- already read off the caller's own verified JWT) is otherwise only readable
-- by a service-role client, never a bare `select * from auth.users` from
-- `anon`/`authenticated`. This migration adds ONE narrow, membership-gated
-- read: a caller may resolve the handle/avatar of any user who shares an org
-- WITH them, and ONLY for that org — never a global user directory.
--
-- SECURITY DEFINER + STABLE (read-only), gated via the existing
-- `lorekit_org_role` membership-truth function (00015) — the exact same
-- "NULL role denies everything" shape used throughout 00012/00015/00020.
-- No insert/update path, no direct grant on `auth.users` to anon/authenticated.
--
-- Takes `p_org_id` (not a slug) to match every sibling Phase 3 management RPC
-- (`lorekit_org_rename`/`_delete`/`_member_remove`/`_member_role`/`_leave` all
-- take `p_org_id`) — the dashboard always already has the org's uuid in scope
-- (from `listMyOrgs()`/`listMembers()`), so a slug->id lookup would be an
-- extra, inconsistent hop for this one RPC alone.
create or replace function lorekit_org_members_list(p_org_id uuid)
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
begin
  -- Non-member (including a non-existent org — lorekit_org_role resolves to
  -- NULL either way): return an EMPTY set, never raise and never leak
  -- whether the org exists. Mirrors the "NULL role denies everything" gate
  -- shape used throughout 00012/00015/00020.
  if lorekit_org_role(auth.uid(), p_org_id) is null then
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
grant execute on function lorekit_org_members_list(uuid) to authenticated, service_role;
