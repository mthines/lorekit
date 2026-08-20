-- ═════════════════════════════════════════════════════════════════════════
-- Scope-authorized restore, symmetric with 00071's archive/delete.
--
-- 00071 let a scoped key archive/delete any writer's row within its allowlist,
-- but restore stayed own-rows-only (`restore_memory` was `where user_id =
-- v_actor`, and both the MCP `toolRestore` and the REST restore handler ran a
-- raw `.update({archived_at:null}).eq('user_id', userId)`). So a key could
-- archive a teammate's row in its scope and then be unable to un-archive it.
--
-- This rewrites `restore_memory` to mirror `memory_delete` (00071): it takes the
-- calling key's scoping, applies the same service-role + non-empty-allowlist
-- widening, and returns `existed` so a 0-row restore is reported as not_found vs
-- forbidden. The signature changes (adds the three key params) and the return
-- becomes a row, so the function is DROPped and recreated; no edge/Node/web
-- caller referenced the old `returns uuid` form (both surfaces did a direct
-- update), so this revives the RPC as the single authorization site rather than
-- changing a live contract.
--
-- `existed` here is scoped to ARCHIVED rows: restore acts only on an archived
-- row, so an already-active row is not "restorable" and reads as not_found,
-- which is the truthful signal for the caller.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists restore_memory(uuid, text, text);

create or replace function restore_memory(
  p_user_id uuid,
  p_scope   text default null,
  p_key     text default null,
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (restored boolean, existed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count   integer;
  v_existed boolean;
  v_actor   uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  -- Same gate as memory_delete (00071): a scoped key on the trusted
  -- service-role connection manages the whole allowlist; an unscoped key and
  -- any non-service-role caller stay own-rows-only (auth.uid() pins them),
  -- preserving the 00046 actor guard against a request-supplied p_key_scopes.
  v_scope_managed boolean := (
    auth.role() = 'service_role'
    and array_length(p_key_scopes, 1) is not null
  );
  -- The SERVICE tier, exactly as in 00071's `memory_delete` — see that header
  -- for the full argument. Short form: the bare service-role key authenticates
  -- as no user and no key, so `p_user_id` is null AND `auth.uid()` is null,
  -- leaving v_actor NULL and every ownership disjunct below NULL. Restore has to
  -- answer this the same way removal does, or a row the service tier can archive
  -- is a row it cannot un-archive.
  v_service_tier boolean := (
    auth.role() = 'service_role'
    and p_user_id is null
  );
begin
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  -- Visibility of an ARCHIVED (restorable) row, broader than the restore WHERE
  -- for a service-role caller so `existed=true, restored=false` is a meaningful
  -- forbidden signal; a non-service-role caller never sees another user's row.
  v_existed := case
    when auth.role() = 'service_role' then exists(
      select 1 from memories m
       where m.scope = p_scope and m.key = p_key and m.archived_at is not null
    )
    else exists(
      select 1 from memories m
       where m.scope = p_scope and m.key = p_key and m.archived_at is not null
         and ( m.user_id = v_actor
               or m.org_id in (select lorekit_member_org_ids(v_actor)) )
    )
  end;

  update memories m
     set archived_at = null
   where m.scope = p_scope and m.key = p_key and m.archived_at is not null
     and ( v_service_tier
           or m.user_id = v_actor
           or m.org_id in (select lorekit_member_org_ids(v_actor))
           or ( v_scope_managed
                and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id) ) );
  get diagnostics v_count = row_count;

  return query select (v_count > 0), (v_existed or v_count > 0);
end;
$$;

revoke execute on function restore_memory(uuid, text, text, text[], text, uuid[])
  from public, anon;
grant execute on function restore_memory(uuid, text, text, text[], text, uuid[])
  to authenticated, service_role;

comment on function restore_memory(uuid, text, text, text[], text, uuid[]) is
  'Un-archives a memory and reports whether a restorable (archived) row the
   caller may see existed. A key with a non-empty scope allowlist reaching this
   on the service-role connection restores any writer''s row within its
   scopes/orgs; an unscoped key and any non-service-role caller stay pinned to
   their own (and member-org) rows — the 00046/00071 actor guard, applied to
   restore. The service tier (service-role connection, no p_user_id — no user and
   no key) is unpinned: it has no actor to be pinned to.';
