-- ═════════════════════════════════════════════════════════════════════════
-- Scope → org binding: bind a scope (e.g. a repo) to an org so writes under it
-- are routed to the org automatically, without each write naming the org.
--
-- Authorization stays server-derived, never caller-trusted (the Phase 2 rule):
--   • Creating a binding requires the actor be an admin/owner of the org
--     (new `manage_scopes` capability on lorekit_org_can).
--   • A write under a bound scope is routed to the org ONLY IF the writer is a
--     write-capable member of that org. A non-member's (or viewer's) write
--     falls back to PERSONAL — never rejected, never silently lost: memory_write
--     reports the bound org's slug back so the caller can surface an actionable
--     notice ("saved personal; this scope is shared with <org>, ask an admin").
--
-- Precedence: an explicit p_org_slug on memory_write always wins; the binding
-- only applies when no org was named.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. The binding table. One org per scope GLOBALLY (unique on scope) so
--    auto-routing is unambiguous — a scope can't be bound to two orgs. A
--    soft-deleted org's binding is harmless: memory_write joins orgs and skips
--    deleted ones (and the FK cascade removes the binding on a real purge).
create table org_scope_bindings (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  scope      text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create unique index org_scope_bindings_scope_uniq on org_scope_bindings (scope);
create index org_scope_bindings_org_idx on org_scope_bindings (org_id);

alter table org_scope_bindings enable row level security;

-- Members of the org can see its bindings (the dashboard's "Shared scopes"
-- list). No insert/update/delete policy — all writes go through the RPCs below,
-- mirroring orgs/org_members/org_invites (Phase 3).
create policy "rls_scope_bindings_select"
  on org_scope_bindings for select
  using (org_id in (select lorekit_member_org_ids(auth.uid())));

grant select on org_scope_bindings to authenticated, service_role;

-- 2. Extend lorekit_org_can with `manage_scopes` (admin/owner) — the single
--    role→capability source, extended, never re-derived. Body is 00022's
--    verbatim plus the one new capability line.
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
    when 'manage_scopes' then v_role in ('admin', 'owner')
    when 'delete_org'    then v_role = 'owner'
    else false
  end;
end;
$$;

-- 3. Bind / unbind RPCs. SECURITY DEFINER, actor = auth.uid() (dashboard JWT
--    session — the Phase 3 pattern; NO caller-supplied user-id). Gated on
--    `manage_scopes`. Bind is idempotent for the same (org, scope); a scope
--    already bound to a DIFFERENT org raises a distinct 'scope_bound_elsewhere'
--    so the caller can report the conflict.
create or replace function lorekit_scope_bind(p_org_id uuid, p_scope text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_existing_org uuid;
  v_id uuid;
begin
  if p_scope is null or length(trim(p_scope)) = 0 then
    raise exception using errcode = 'P0001', message = 'scope is required';
  end if;

  if not lorekit_org_can(v_actor, p_org_id, 'manage_scopes') then
    raise exception using errcode = 'LK002',
      message = format('org_permission_denied: org=%s capability=manage_scopes', p_org_id);
  end if;

  select org_id, id into v_existing_org, v_id from org_scope_bindings where scope = p_scope;
  if v_existing_org = p_org_id then
    -- Already bound to this org — idempotent no-op; return the existing id.
    return v_id;
  elsif v_existing_org is not null then
    raise exception using errcode = 'P0001',
      message = format('scope_bound_elsewhere: %s', p_scope);
  end if;

  insert into org_scope_bindings (org_id, scope, created_by)
  values (p_org_id, p_scope, v_actor)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function lorekit_scope_unbind(p_org_id uuid, p_scope text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_scope is null or length(trim(p_scope)) = 0 then
    raise exception using errcode = 'P0001', message = 'scope is required';
  end if;

  if not lorekit_org_can(v_actor, p_org_id, 'manage_scopes') then
    raise exception using errcode = 'LK002',
      message = format('org_permission_denied: org=%s capability=manage_scopes', p_org_id);
  end if;

  delete from org_scope_bindings where org_id = p_org_id and scope = p_scope;
end;
$$;

grant execute on function lorekit_scope_bind(uuid, text) to authenticated, service_role;
grant execute on function lorekit_scope_unbind(uuid, text) to authenticated, service_role;

-- 4. Recreate memory_write with scope-binding auto-routing. The return type
--    grows two additive columns — `org_routed` (did the row land in an org?)
--    and `binding_org_slug` (the bound org's slug when a binding exists for the
--    scope, regardless of routing) — so the caller can build the graceful
--    fallback notice. Changing the RETURNS TABLE shape requires a drop first.
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text);

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null,
  p_org_slug     text        default null
)
returns table (id uuid, created_at timestamptz, inserted boolean, org_routed boolean, binding_org_slug text)
language plpgsql
set search_path = public
as $$
declare
  v_org_id       uuid;
  v_binding_org  uuid;
  v_binding_slug text;
begin
  if p_org_slug is not null then
    -- Explicit org selector — takes precedence over any binding.
    select o.id into v_org_id from orgs o where o.slug = p_org_slug and o.deleted_at is null;
    if v_org_id is null then
      raise exception using errcode = 'P0001', message = format('unknown_org: %s', p_org_slug);
    end if;
    if not lorekit_org_can(p_user_id, v_org_id, 'write') then
      raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s', p_org_slug);
    end if;
  else
    -- No explicit org: consult the scope binding. Resolve the bound org (if any,
    -- excluding soft-deleted orgs). Route to it only when the writer is a
    -- write-capable member; otherwise fall through to a personal/service write
    -- but still report the bound slug so the caller can surface a notice.
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where b.scope = p_scope and o.deleted_at is null;

    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write') then
      v_org_id := v_binding_org;
    end if;
  end if;

  if v_org_id is not null then
    -- Org-owned write (explicit slug OR binding-routed). user_id stays NULL;
    -- created_by/updated_by record the writer. org_routed = true.
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()), p_user_id, p_user_id
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted,
              true as org_routed, v_binding_slug as binding_org_slug;

  elsif p_user_id is null then
    -- service-role / CI write.
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at, created_by, updated_by)
    values (null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()), null, null)
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted,
              false as org_routed, v_binding_slug as binding_org_slug;
  else
    -- user-scoped (api_key / user) personal write — includes the binding
    -- fallback case (a binding exists but the writer can't write to it).
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at, created_by, updated_by)
    values (p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()), p_user_id, p_user_id)
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted,
              false as org_routed, v_binding_slug as binding_org_slug;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text)
  to anon, authenticated, service_role;
