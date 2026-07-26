-- Role-gated memory_delete RPC — the org side of destructive ops.
--
-- The edge api_key path is a service-role client that bypasses RLS, so a raw
-- org-targeted `.delete()`/`.update()` would have NO gate at all. Role
-- enforcement for org rows must therefore live in a SECURITY DEFINER RPC that
-- calls lorekit_org_can (00015), mirroring memory_write's org branch.
--
-- Personal delete (p_org_slug NULL) mirrors today's raw .eq('user_id', ...)
-- behavior exactly — the well-tested personal path is intentionally left
-- untouched elsewhere (tools.ts, mcp-core delete.ts) to minimize blast radius
-- on a security-critical change; this RPC only absorbs the org-targeted case
-- plus a personal fallback so callers have one entry point.
--
-- Capability required: 'archive' for a soft-delete (p_force = false),
-- 'hard_delete' for p_force = true. A viewer is denied both; a member may
-- soft-archive but not hard-delete; admin/owner may do both. Any denial
-- raises SQLSTATE 'LK002' (same signal as memory_write's org-permission
-- denial) so the app layer translates it identically.
--
-- An unresolvable slug raises 'unknown_org', matching memory_write.

create or replace function memory_delete(
  p_user_id  uuid,
  p_org_slug text default null,
  p_scope    text default null,
  p_key      text default null,
  p_force    boolean default false
)
returns table (deleted boolean, archived boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_count  integer;
begin
  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug;
    if v_org_id is null then
      raise exception using
        errcode = 'P0001',
        message = format('unknown_org: %s', p_org_slug);
    end if;

    if p_force then
      if not lorekit_org_can(p_user_id, v_org_id, 'hard_delete') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=hard_delete', p_org_slug);
      end if;

      delete from memories
       where org_id = v_org_id and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      if not lorekit_org_can(p_user_id, v_org_id, 'archive') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=archive', p_org_slug);
      end if;

      update memories
         set archived_at = now()
       where org_id = v_org_id and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0);
    end if;
  else
    -- Personal delete: mirrors the existing .eq('user_id', p_user_id) path.
    if p_force then
      delete from memories
       where user_id = p_user_id and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      update memories
         set archived_at = now()
       where user_id = p_user_id and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0);
    end if;
  end if;
end;
$$;

grant execute on function memory_delete(uuid, text, text, text, boolean) to anon, authenticated, service_role;
