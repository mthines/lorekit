-- ═════════════════════════════════════════════════════════════════════════
-- API-token scope-authorized removal, and a not-found / not-permitted signal.
--
-- ── The problem ──────────────────────────────────────────────────────────
-- Since 00046 every memory-removal path is pinned to the resolved actor's OWN
-- rows: `where user_id = v_actor` (personal) or an org capability (org). An
-- `lk_*` API token therefore reaches the store on the service-role connection
-- (getDb: "api_key ... use service-role") yet can only remove rows it wrote.
-- The two MCP tools that back `memory.archive` and personal `memory.delete`
-- (`toolArchive`, `toolDelete`) run a raw `.update()/.delete()` filtered by
-- `.eq('user_id', userId)` and ignore the key's scope allowlist entirely, so a
-- key deliberately SCOPED to `repo::x` still cannot manage rows in `repo::x`
-- that another principal wrote. Worse, a 0-row result returns
-- `{archived:false}` — indistinguishable from "no such memory", so the caller
-- cannot tell "already gone" from "not yours".
--
-- ── The change (two additive parts) ──────────────────────────────────────
-- 1. `existed` return column. `memory_delete` now returns whether a row for
--    (scope,key) that the caller may SEE exists, so the edge can map a 0-row
--    removal to `not_found` (nothing there) vs `forbidden` (present, but this
--    call removed nothing — another principal's row outside the key's reach,
--    or already archived). For a NON-service-role caller `existed` never
--    reflects another user's row, so the RPC cannot be used to enumerate the
--    store.
--
-- 2. Scope-authorized personal removal. A key that carries a NON-EMPTY scope
--    allowlist AND reaches this function on the trusted service-role
--    connection may archive / hard-delete EVERY writer's row for (scope,key)
--    within the scopes and orgs it is scoped to — the authority the owner
--    granted by scoping the key. Both conjuncts are load-bearing:
--      • `auth.role() = 'service_role'` — the edge resolves `p_key_scopes`
--        from the AUTHENTICATED token, never from request input. Without this
--        gate a raw `authenticated` PostgREST caller could pass an allowlist
--        and delete another user's rows — the exact IDOR 00046 closed. For
--        such a caller `auth.uid()` still pins the actor and the widening is
--        never reached.
--      • `array_length(p_key_scopes, 1) is not null` — an UNSCOPED key ('{}')
--        gets no widening and stays own-rows-only, so scoping a key UP is what
--        grants management authority, and the default key is unaffected.
--    The scope itself is already asserted allowed at the top (LK002 otherwise),
--    and org tenancy is re-checked per row via `lorekit_api_token_org_allowed`.
--
-- Actor resolution, the org capability gates and the grants are 00068 verbatim;
-- only the `existed` column, the `v_scope_managed` widening and the personal
-- branch's WHERE are new.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists memory_delete(uuid, text, text, text, boolean, text[], text, uuid[]);

create or replace function memory_delete(
  p_user_id  uuid,
  p_org_slug text default null,
  p_scope    text default null,
  p_key      text default null,
  p_force    boolean default false,
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (deleted boolean, archived boolean, existed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id  uuid;
  v_count   integer;
  v_existed boolean;
  v_actor   uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  -- A scoped key on the trusted service-role connection manages the whole
  -- allowed scope, not just its owner's rows. See the header for why BOTH
  -- conjuncts are load-bearing (service_role gate closes the p_key_scopes IDOR;
  -- the length check keeps an unscoped key own-rows-only).
  v_scope_managed boolean := (
    auth.role() = 'service_role'
    and array_length(p_key_scopes, 1) is not null
  );
begin
  -- The scope allowlist, before either branch. LK002 maps to a 403 on both
  -- surfaces, so no second mapping is needed here.
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug;
    if v_org_id is null then
      raise exception using
        errcode = 'P0001',
        message = format('unknown_org: %s', p_org_slug);
    end if;

    -- The tenancy half, before the capability gates so the denial names the
    -- key, not its owner's role.
    if not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_org_id) then
      raise exception using errcode = 'LK002',
        message = format('key_org_denied: org=%s', p_org_slug);
    end if;

    v_existed := exists(
      select 1 from memories m
       where m.org_id = v_org_id and m.scope = p_scope and m.key = p_key
    );

    if p_force then
      if not lorekit_org_can(v_actor, v_org_id, 'hard_delete') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=hard_delete', p_org_slug);
      end if;

      delete from memories
       where org_id = v_org_id and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false, v_existed;
    else
      if not lorekit_org_can(v_actor, v_org_id, 'archive') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=archive', p_org_slug);
      end if;

      update memories
         set archived_at = now()
       where org_id = v_org_id and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0), v_existed;
    end if;
  else
    -- Personal / scope-authorized branch.
    --
    -- `existed` is the caller's VISIBILITY of (scope,key), deliberately BROADER
    -- than the removal WHERE below so that `existed=true, removed=false` is a
    -- meaningful "present but not removed by this call" (forbidden / already
    -- archived) rather than collapsing into not_found. A service-role caller
    -- (the edge, which can already read the whole scope via memory.list) sees
    -- any row; a non-service-role caller sees only its own / member-org rows,
    -- so it can never enumerate another user's memories.
    v_existed := case
      when auth.role() = 'service_role' then exists(
        select 1 from memories m where m.scope = p_scope and m.key = p_key
      )
      else exists(
        select 1 from memories m
         where m.scope = p_scope and m.key = p_key
           and ( m.user_id = v_actor
                 or m.org_id in (select lorekit_member_org_ids(v_actor)) )
      )
    end;

    if p_force then
      delete from memories m
       where m.scope = p_scope and m.key = p_key
         and ( m.user_id = v_actor
               or m.org_id in (select lorekit_member_org_ids(v_actor))
               or ( v_scope_managed
                    and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id) ) );
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false, (v_existed or v_count > 0);
    else
      update memories m
         set archived_at = now()
       where m.scope = p_scope and m.key = p_key and m.archived_at is null
         and ( m.user_id = v_actor
               or m.org_id in (select lorekit_member_org_ids(v_actor))
               or ( v_scope_managed
                    and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id) ) );
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0), (v_existed or v_count > 0);
    end if;
  end if;
end;
$$;

-- 00046/00068's revoke is carried over verbatim against the (unchanged)
-- signature: 00020 granted `anon` EXPLICITLY, and `revoke … from public` does
-- not remove a per-role grant, so anon must be named again or the re-created
-- function silently comes back reachable.
revoke execute on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[])
  from public, anon;
grant execute on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[])
  to authenticated, service_role;

comment on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[]) is
  'Archives (p_force=false) or hard-deletes (p_force=true) a memory and reports
   whether a row for (scope,key) the caller may see existed. A key with a
   non-empty scope allowlist reaching this function on the service-role
   connection manages every writer''s row within the scopes/orgs it is scoped
   to; an unscoped key, and any non-service-role caller, stay pinned to their
   own (and member-org) rows, preserving the 00046 actor guard. Org removals
   remain gated on the archive / hard_delete capability.';
