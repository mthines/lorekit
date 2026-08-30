-- Retention policies, part 3: the SAME eight dimension filters the Lore
-- Explorer's filter bar offers (label/kind/host/agent/trigger/repo/branch/PR
-- — `lib/filters.ts`'s `FILTER_FIELDS`, minus `owner`: a policy's `scope`
-- already partitions personal-vs-org lore, so a second ownership predicate
-- would either agree with it or silently fight it).
--
-- Until now a policy could only narrow by scope + the three age/activity
-- thresholds (00088). "Create retention policy" on the Explorer therefore
-- dropped every dimension filter a reader had set — the exact gap this
-- migration closes, so a policy created FROM a filtered Explorer view
-- actually reproduces that view's narrowing, not just its age conditions.
--
-- Reuses the dimension-filter helpers `lorekit_memory_facets`/
-- `lorekit_memory_list` already compose (`lorekit_match_text` /
-- `lorekit_match_tags`, migration 00066) — one definition of what `nin` /
-- `all`/`any`/`none` mean, not a third copy of it. `origin_pr` matches as
-- TEXT here (`m.origin_pr::text` against a digit-string filter), not via
-- `lorekit_match_int`: the wire and the Explorer's filter bar both speak
-- digit strings for this dimension (`ListMemoriesBodySchema.origin_pr` is a
-- string list too), and a policy's stored `origin_pr` column is `text[]` to
-- match — avoiding a second representation for the one dimension that would
-- otherwise need it.
--
-- 1. retention_policies — eight new (filter, mode) column pairs, all
--    nullable and defaulting to null/'in' — additive, so every existing row
--    reads back with every new filter "not narrowed", unchanged behaviour.
alter table retention_policies
  add column if not exists tags                text[],
  add column if not exists tags_mode           text default 'any',
  add column if not exists source_agent        text[],
  add column if not exists source_agent_mode   text default 'in',
  add column if not exists trigger             text[],
  add column if not exists trigger_mode        text default 'in',
  add column if not exists kind                text[],
  add column if not exists kind_mode           text default 'in',
  add column if not exists host                text[],
  add column if not exists host_mode           text default 'in',
  add column if not exists origin_repo         text[],
  add column if not exists origin_repo_mode    text default 'in',
  add column if not exists origin_branch       text[],
  add column if not exists origin_branch_mode  text default 'in',
  add column if not exists origin_pr           text[],
  add column if not exists origin_pr_mode      text default 'in';

-- 2. lorekit_groom_candidates — the single source of truth for "what
--    matches", extended with the eight filters. `language sql`, so the new
--    parameters are referenced by NAME in the body, not by a `$N` position —
--    unlike `lorekit_memory_list` (00092), this function has no dynamic
--    `execute format(...)` to renumber. Appended at the end of the argument
--    list so this is additive for the same reason 00092's append was: every
--    caller uses PostgREST's named-argument RPC form, so an appended,
--    defaulted parameter changes no existing caller's behaviour.
--
--    `create or replace` only replaces a function whose PARAMETER LIST
--    matches exactly — a longer list (even all-defaulted) creates a SECOND
--    overload instead, and a 5-arg call then becomes ambiguous ("not unique")
--    because both overloads can satisfy it via defaults. Drop the 00088
--    signature first so there is exactly one `lorekit_groom_candidates`.
drop function if exists lorekit_groom_candidates(uuid, text, integer, integer, integer);

create or replace function lorekit_groom_candidates(
  p_user_id             uuid,
  p_scope               text,
  p_min_age_days        integer default null,
  p_unseen_days         integer default null,
  p_max_seen_count      integer default null,
  p_tags                text[]  default null,
  p_tags_mode           text    default 'any',
  p_source_agent        text[]  default null,
  p_source_agent_mode   text    default 'in',
  p_trigger             text[]  default null,
  p_trigger_mode        text    default 'in',
  p_kind                text[]  default null,
  p_kind_mode           text    default 'in',
  p_host                text[]  default null,
  p_host_mode           text    default 'in',
  p_origin_repo         text[]  default null,
  p_origin_repo_mode    text    default 'in',
  p_origin_branch       text[]  default null,
  p_origin_branch_mode  text    default 'in',
  p_origin_pr           text[]  default null,
  p_origin_pr_mode      text    default 'in'
)
returns table (id uuid, scope text, key text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.scope, m.key
    from memories m
   where m.user_id = p_user_id
     and m.archived_at is null
     and m.protected = false
     and (
       p_scope = 'global'
       or m.scope = p_scope
       or (
         p_scope like 'repo::%'
         and starts_with(m.scope, 'branch::' || substring(p_scope from 7) || '::')
       )
     )
     and (p_min_age_days is null or m.created_at <= now() - (p_min_age_days * interval '1 day'))
     and (p_unseen_days is null or coalesce(m.last_seen_at, '-infinity'::timestamptz) <= now() - (p_unseen_days * interval '1 day'))
     and (p_max_seen_count is null or m.seen_count <= p_max_seen_count)
     and lorekit_match_tags(m.tags,               p_tags,          p_tags_mode)
     and lorekit_match_text(m.source_agent,       p_source_agent,   p_source_agent_mode)
     and lorekit_match_text(m.trigger,            p_trigger,        p_trigger_mode)
     and lorekit_match_text(m.kind,               p_kind,           p_kind_mode)
     and lorekit_match_text(m.host,               p_host,           p_host_mode)
     and lorekit_match_text(m.origin_repo,        p_origin_repo,    p_origin_repo_mode)
     and lorekit_match_text(m.origin_branch,      p_origin_branch,  p_origin_branch_mode)
     and lorekit_match_text(m.origin_pr::text,    p_origin_pr,      p_origin_pr_mode)
   order by m.scope, m.key;
$$;

grant execute on function lorekit_groom_candidates(
  uuid, text, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) to authenticated, service_role;

-- 3. lorekit_groom_run — forwards the same eight filters to
--    lorekit_groom_candidates (never a second candidate query). Same
--    overload hazard as above — drop the 00088 5-arg signature first.
drop function if exists lorekit_groom_run(uuid, text, integer, integer, integer);

create or replace function lorekit_groom_run(
  p_user_id             uuid,
  p_scope               text,
  p_min_age_days        integer default null,
  p_unseen_days         integer default null,
  p_max_seen_count      integer default null,
  p_tags                text[]  default null,
  p_tags_mode           text    default 'any',
  p_source_agent        text[]  default null,
  p_source_agent_mode   text    default 'in',
  p_trigger             text[]  default null,
  p_trigger_mode        text    default 'in',
  p_kind                text[]  default null,
  p_kind_mode           text    default 'in',
  p_host                text[]  default null,
  p_host_mode           text    default 'in',
  p_origin_repo         text[]  default null,
  p_origin_repo_mode    text    default 'in',
  p_origin_branch       text[]  default null,
  p_origin_branch_mode  text    default 'in',
  p_origin_pr           text[]  default null,
  p_origin_pr_mode      text    default 'in'
)
returns table (archived integer, keys jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids   uuid[];
  v_keys  jsonb;
  v_count integer := 0;
begin
  select coalesce(array_agg(c.id), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('scope', c.scope, 'key', c.key)), '[]'::jsonb)
    into v_ids, v_keys
    from lorekit_groom_candidates(
      p_user_id, p_scope, p_min_age_days, p_unseen_days, p_max_seen_count,
      p_tags, p_tags_mode, p_source_agent, p_source_agent_mode,
      p_trigger, p_trigger_mode, p_kind, p_kind_mode, p_host, p_host_mode,
      p_origin_repo, p_origin_repo_mode, p_origin_branch, p_origin_branch_mode,
      p_origin_pr, p_origin_pr_mode
    ) c;

  if array_length(v_ids, 1) is null then
    return query select 0, '[]'::jsonb;
    return;
  end if;

  update memories m
     set archived_at = now()
   where m.id = any(v_ids)
     and m.archived_at is null;
  get diagnostics v_count = row_count;

  return query select v_count, v_keys;
end;
$$;

grant execute on function lorekit_groom_run(
  uuid, text, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) to authenticated, service_role;

-- 4. lorekit_groom_sweep — passes a swept policy's new filter columns
--    through to lorekit_groom_run, unchanged shape otherwise.
create or replace function lorekit_groom_sweep()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy retention_policies%rowtype;
  v_result record;
  v_total  integer := 0;
begin
  for v_policy in
    select * from retention_policies where mode = 'auto' and enabled = true
  loop
    select * into v_result
      from lorekit_groom_run(
        v_policy.user_id, v_policy.scope,
        v_policy.min_age_days, v_policy.unseen_days, v_policy.max_seen_count,
        v_policy.tags, v_policy.tags_mode,
        v_policy.source_agent, v_policy.source_agent_mode,
        v_policy.trigger, v_policy.trigger_mode,
        v_policy.kind, v_policy.kind_mode,
        v_policy.host, v_policy.host_mode,
        v_policy.origin_repo, v_policy.origin_repo_mode,
        v_policy.origin_branch, v_policy.origin_branch_mode,
        v_policy.origin_pr, v_policy.origin_pr_mode
      );
    v_total := v_total + coalesce(v_result.archived, 0);
  end loop;

  return v_total;
end;
$$;

grant execute on function lorekit_groom_sweep() to service_role;

-- 5. lorekit_policy_create — the eight filters, appended. Same overload
--    hazard as `lorekit_groom_candidates` above — drop the 00088 8-arg
--    signature first.
drop function if exists lorekit_policy_create(uuid, text, text, text, boolean, integer, integer, integer);

create or replace function lorekit_policy_create(
  p_user_id             uuid,
  p_scope               text,
  p_name                text,
  p_mode                text    default 'review',
  p_enabled             boolean default false,
  p_min_age_days        integer default null,
  p_unseen_days         integer default null,
  p_max_seen_count      integer default null,
  p_tags                text[]  default null,
  p_tags_mode           text    default 'any',
  p_source_agent        text[]  default null,
  p_source_agent_mode   text    default 'in',
  p_trigger             text[]  default null,
  p_trigger_mode        text    default 'in',
  p_kind                text[]  default null,
  p_kind_mode           text    default 'in',
  p_host                text[]  default null,
  p_host_mode           text    default 'in',
  p_origin_repo         text[]  default null,
  p_origin_repo_mode    text    default 'in',
  p_origin_branch       text[]  default null,
  p_origin_branch_mode  text    default 'in',
  p_origin_pr           text[]  default null,
  p_origin_pr_mode      text    default 'in'
)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  insert into retention_policies (
    user_id, scope, name, mode, enabled, min_age_days, unseen_days, max_seen_count,
    tags, tags_mode, source_agent, source_agent_mode, trigger, trigger_mode,
    kind, kind_mode, host, host_mode, origin_repo, origin_repo_mode,
    origin_branch, origin_branch_mode, origin_pr, origin_pr_mode
  )
  values (
    p_user_id, p_scope, p_name, p_mode, p_enabled, p_min_age_days, p_unseen_days, p_max_seen_count,
    p_tags, p_tags_mode, p_source_agent, p_source_agent_mode, p_trigger, p_trigger_mode,
    p_kind, p_kind_mode, p_host, p_host_mode, p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode, p_origin_pr, p_origin_pr_mode
  )
  returning *;
$$;

grant execute on function lorekit_policy_create(
  uuid, text, text, text, boolean, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) to authenticated, service_role;

-- 6. lorekit_policy_update — the same has-key / json-null-clears JSONB patch
--    convention as 00088, extended to the eight new array + mode columns. An
--    array column's clear needs its own branch (`p_patch->'tags' = 'null'::jsonb`)
--    because `jsonb_array_elements_text` raises on a JSON null rather than
--    returning zero rows.
create or replace function lorekit_policy_update(
  p_user_id uuid,
  p_id      uuid,
  p_patch   jsonb
)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  update retention_policies
     set name                = case when p_patch ? 'name'                then p_patch ->> 'name'                          else name end,
         mode                 = case when p_patch ? 'mode'                then p_patch ->> 'mode'                          else mode end,
         enabled              = case when p_patch ? 'enabled'             then (p_patch ->> 'enabled')::boolean            else enabled end,
         min_age_days         = case when p_patch ? 'min_age_days'        then (p_patch ->> 'min_age_days')::integer       else min_age_days end,
         unseen_days          = case when p_patch ? 'unseen_days'         then (p_patch ->> 'unseen_days')::integer        else unseen_days end,
         max_seen_count       = case when p_patch ? 'max_seen_count'      then (p_patch ->> 'max_seen_count')::integer     else max_seen_count end,
         tags                 = case when p_patch ? 'tags'                then (case when p_patch -> 'tags'                = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'tags')) end)                else tags end,
         tags_mode            = case when p_patch ? 'tags_mode'           then p_patch ->> 'tags_mode'                     else tags_mode end,
         source_agent         = case when p_patch ? 'source_agent'        then (case when p_patch -> 'source_agent'        = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'source_agent')) end)         else source_agent end,
         source_agent_mode    = case when p_patch ? 'source_agent_mode'   then p_patch ->> 'source_agent_mode'             else source_agent_mode end,
         trigger              = case when p_patch ? 'trigger'             then (case when p_patch -> 'trigger'             = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'trigger')) end)              else trigger end,
         trigger_mode         = case when p_patch ? 'trigger_mode'        then p_patch ->> 'trigger_mode'                  else trigger_mode end,
         kind                 = case when p_patch ? 'kind'                then (case when p_patch -> 'kind'                = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'kind')) end)                 else kind end,
         kind_mode            = case when p_patch ? 'kind_mode'           then p_patch ->> 'kind_mode'                     else kind_mode end,
         host                 = case when p_patch ? 'host'                then (case when p_patch -> 'host'                = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'host')) end)                 else host end,
         host_mode            = case when p_patch ? 'host_mode'           then p_patch ->> 'host_mode'                     else host_mode end,
         origin_repo          = case when p_patch ? 'origin_repo'         then (case when p_patch -> 'origin_repo'         = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'origin_repo')) end)          else origin_repo end,
         origin_repo_mode     = case when p_patch ? 'origin_repo_mode'    then p_patch ->> 'origin_repo_mode'              else origin_repo_mode end,
         origin_branch        = case when p_patch ? 'origin_branch'       then (case when p_patch -> 'origin_branch'       = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'origin_branch')) end)        else origin_branch end,
         origin_branch_mode   = case when p_patch ? 'origin_branch_mode'  then p_patch ->> 'origin_branch_mode'            else origin_branch_mode end,
         origin_pr            = case when p_patch ? 'origin_pr'           then (case when p_patch -> 'origin_pr'           = 'null'::jsonb then null else array(select jsonb_array_elements_text(p_patch -> 'origin_pr')) end)            else origin_pr end,
         origin_pr_mode       = case when p_patch ? 'origin_pr_mode'      then p_patch ->> 'origin_pr_mode'                else origin_pr_mode end
   where id = p_id and user_id = p_user_id
  returning *;
$$;

grant execute on function lorekit_policy_update(uuid, uuid, jsonb) to authenticated, service_role;
