-- Invite-details modal: lets a PENDING (non-member) invitee see which org
-- invited them before accepting. `listPendingInvitesForMe`'s `orgs(name,
-- slug)` embed resolves to null for a non-member (the org read policy,
-- 00014/00025, is member-only), so today the banner falls back to the
-- literal "Someone invited you to an organization" with no name — the UX
-- problem this migration's read path fixes.
--
-- SECURITY DEFINER, gated on the EXISTING `lorekit_invite_addressed_to_caller`
-- (00022) — never re-derived, never re-widened. Returns Tier-A fields ONLY
-- (org name, slug, created_at, an aggregate member COUNT, the inviter's
-- handle/avatar) — explicitly NO per-member identity list (Tier B, declined
-- by the user in Phase 0). This migration adds NO policy and touches NO
-- existing function or policy — it is a pure, additive read path, mirroring
-- `lorekit_org_members_list`'s (00024) "gate, then join auth.users for one
-- identity" shape, applied to the ADDRESSED-INVITEE gate instead of the
-- membership gate.
create or replace function lorekit_invite_org_details(p_invite_id uuid)
returns table (
  org_name           text,
  org_slug           text,
  org_created_at     timestamptz,
  member_count       int,
  inviter_handle     text,
  inviter_avatar_url text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  inv org_invites;
begin
  select * into inv from org_invites where id = p_invite_id;

  -- No such invite, not pending, or not addressed to the caller: return an
  -- EMPTY set, never raise and never leak whether the invite exists — the
  -- same "gate denies silently, by returning nothing" shape used throughout
  -- 00022/00024.
  if inv.id is null or inv.status <> 'pending' or not lorekit_invite_addressed_to_caller(inv) then
    return;
  end if;

  return query
    select
      o.name,
      o.slug,
      o.created_at,
      (select count(*) from org_members where org_id = inv.org_id)::int,
      coalesce(u.raw_user_meta_data ->> 'user_name', u.raw_user_meta_data ->> 'preferred_username'),
      u.raw_user_meta_data ->> 'avatar_url'
    from orgs o
    left join auth.users u on u.id = inv.invited_by
    where o.id = inv.org_id and o.deleted_at is null;
end;
$$;

-- No `anon` grant: this function returns PII (inviter handle/avatar, member
-- count) about an org the caller isn't yet a member of. Authenticated-only,
-- the same defense-in-depth posture as `lorekit_org_members_list` (00024)
-- and every other PII-bearing definer function in this schema.
grant execute on function lorekit_invite_org_details(uuid) to authenticated, service_role;
