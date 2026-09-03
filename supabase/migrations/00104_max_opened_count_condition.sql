-- ═════════════════════════════════════════════════════════════════════════
-- 00104 — `max_opened_count`: the retention condition whose 0 means something.
--
-- WHY max_read_count IS NOT ENOUGH. 00101 added `max_read_count` over
-- `read_count`, which counts EVERY read including bulk list/search
-- ride-alongs. Measured on a live 2,772-memory store the day this was written,
-- that makes the filter almost unusable at the low end:
--
--     max_read_count <= 5     ->     0 memories
--     max_read_count <= 26    ->     the first non-empty result
--     max_read_count <= 50    ->     roughly half the store
--     max_read_count <= 400   ->     essentially everything
--
-- Its whole usable range is a narrow band in the middle, and the grooming UI
-- suggests `0` — a value that can never match anything a `memory.list` has ever
-- paged over, which is every lesson in an active scope. Worse, what it ranks on
-- is SCOPE BREADTH: a `global` lesson rides along in every session and a
-- `branch` lesson almost never, so "read at most N times" selects narrow scopes
-- and calls them unused.
--
-- `opened_count` (00103) counts ONLY a deliberate agent fetch of this exact
-- lesson. `max_opened_count => 0` therefore means exactly what a reader
-- expects — "no agent has ever reached for this" — and it means the same thing
-- for a `global` lesson as for a `branch` one. It is the condition
-- `max_read_count` was reaching for.
--
-- BOTH ARE KEPT, and `max_read_count` is not deprecated here. It answers a real
-- and different question — "what is this lesson COSTING me in context" — which
-- is the other axis of the delivered x chosen grid. Pairing them is what makes
-- the interesting quadrant expressible for the first time:
--
--     max_opened_count => 0            "nothing ever chose it"
--     (with no max_read_count)         ... at any delivery volume
--
-- and, for the prune list that actually saves context, a policy that leaves
-- `max_read_count` unset while setting `max_opened_count => 0` catches the
-- heavily-delivered, never-chosen lessons that `max_read_count` structurally
-- cannot reach.
--
-- NO CUTOVER CAVEAT, unlike 00101. `max_read_count` had to warn that a
-- long-lived lesson can show a low count it never earned, because `read_count`
-- started at 0 when 00084 shipped. `opened_count` was BACKFILLED from
-- `memory_read_daily` in 00103, so it is exact over the whole history the
-- rollup holds and no lesson looks falsely unopened.
--
-- SIGNATURES follow 00101 exactly: `p_max_opened_count` is APPENDED last so
-- positional callers keep working, and every function whose signature changes
-- is DROPPED first — `create or replace` would leave a second overload behind
-- and make every call ambiguous. `lorekit_policy_update` takes a jsonb patch,
-- so it needs no drop; `lorekit_groom_sweep` takes no arguments.
--
-- The index it needs already exists: `memories_user_opened_count_idx` (00103).
-- ═════════════════════════════════════════════════════════════════════════

-- ── the policy column ─────────────────────────────────────────────────────
alter table retention_policies add column if not exists max_opened_count integer;

alter table retention_policies drop constraint if exists retention_policies_max_opened_count_non_negative;
alter table retention_policies add constraint retention_policies_max_opened_count_non_negative
  check (max_opened_count is null or max_opened_count >= 0);

comment on column retention_policies.max_opened_count is
  'Match only lessons an agent has DELIBERATELY fetched at most this many times
   (memories.opened_count, 00103). Unlike max_read_count (00101) a bulk
   list/search ride-along does not count, so 0 means "nothing ever chose this"
   rather than "this lesson happens to live in a narrow scope". NULL =
   unconstrained.';

-- ── 1. lorekit_groom_candidates ───────────────────────────────────────────
drop function if exists lorekit_groom_candidates(
  uuid, text, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, integer
);

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
  p_origin_pr_mode      text    default 'in',
  p_max_read_count      integer default null,
  p_max_opened_count    integer default null
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
     and (p_unseen_days is null or coalesce(m.last_opened_at, m.created_at) <= now() - (p_unseen_days * interval '1 day'))
     and (p_max_seen_count is null or m.seen_count <= p_max_seen_count)
     and (p_max_read_count is null or m.read_count <= p_max_read_count)
     and (p_max_opened_count is null or m.opened_count <= p_max_opened_count)
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
  text[], text, text[], text, text[], text, integer, integer
) to authenticated, service_role;

-- ── 2. lorekit_groom_run ──────────────────────────────────────────────────
drop function if exists lorekit_groom_run(
  uuid, text, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, integer
);

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
  p_origin_pr_mode      text    default 'in',
  p_max_read_count      integer default null,
  p_max_opened_count    integer default null
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
      p_origin_pr, p_origin_pr_mode, p_max_read_count, p_max_opened_count
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
  text[], text, text[], text, text[], text, integer, integer
) to authenticated, service_role;

-- ── 3. lorekit_groom_sweep ────────────────────────────────────────────────
-- No signature change; recreated only to pass the new policy column through.
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
        v_policy.origin_pr, v_policy.origin_pr_mode,
        v_policy.max_read_count, v_policy.max_opened_count
      );
    v_total := v_total + coalesce(v_result.archived, 0);
  end loop;

  return v_total;
end;
$$;

grant execute on function lorekit_groom_sweep() to service_role;

-- ── 4. lorekit_policy_create ──────────────────────────────────────────────
drop function if exists lorekit_policy_create(
  uuid, text, text, text, boolean, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, integer
);

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
  p_origin_pr_mode      text    default 'in',
  p_max_read_count      integer default null,
  p_max_opened_count    integer default null
)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  insert into retention_policies (
    user_id, scope, name, mode, enabled, min_age_days, unseen_days, max_seen_count,
    max_read_count, max_opened_count,
    tags, tags_mode, source_agent, source_agent_mode, trigger, trigger_mode,
    kind, kind_mode, host, host_mode, origin_repo, origin_repo_mode,
    origin_branch, origin_branch_mode, origin_pr, origin_pr_mode
  )
  values (
    p_user_id, p_scope, p_name, p_mode, p_enabled, p_min_age_days, p_unseen_days, p_max_seen_count,
    p_max_read_count, p_max_opened_count,
    p_tags, p_tags_mode, p_source_agent, p_source_agent_mode, p_trigger, p_trigger_mode,
    p_kind, p_kind_mode, p_host, p_host_mode, p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode, p_origin_pr, p_origin_pr_mode
  )
  returning *;
$$;

grant execute on function lorekit_policy_create(
  uuid, text, text, text, boolean, integer, integer, integer,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, integer, integer
) to authenticated, service_role;

-- ── 5. lorekit_policy_update ──────────────────────────────────────────────
-- jsonb patch, so the signature is unchanged and no drop is needed. One more
-- `case when p_patch ? ...` line, matching every other condition: an absent key
-- leaves the column alone, an explicit null clears it.
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
         max_read_count       = case when p_patch ? 'max_read_count'      then (p_patch ->> 'max_read_count')::integer     else max_read_count end,
         max_opened_count     = case when p_patch ? 'max_opened_count'    then (p_patch ->> 'max_opened_count')::integer   else max_opened_count end,
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

-- ── 6. lorekit_memory_list ────────────────────────────────────────────────
-- The Explorer's retention filter bar reads through this, so the condition has
-- to exist on both surfaces or the preview and the policy disagree. Parameter
-- change, so the 00103 definition is dropped by its exact argument list first.
drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer
);

create or replace function lorekit_memory_list(
  p_user_id              uuid,
  p_archived             boolean     default false,
  p_scope                text        default null,
  p_key                  text        default null,
  p_key_prefix           text        default null,
  p_q                    text        default null,
  p_created_since        timestamptz default null,
  p_created_until        timestamptz default null,
  p_expires_after        timestamptz default null,
  p_expires_on_or_before timestamptz default null,
  p_tags                 text[]      default null,
  p_tags_mode            text        default 'any',
  p_source_agent         text[]      default null,
  p_source_agent_mode    text        default 'in',
  p_trigger              text[]      default null,
  p_trigger_mode         text        default 'in',
  p_kind                 text[]      default null,
  p_kind_mode            text        default 'in',
  p_host                 text[]      default null,
  p_host_mode            text        default 'in',
  p_origin_repo          text[]      default null,
  p_origin_repo_mode     text        default 'in',
  p_origin_branch        text[]      default null,
  p_origin_branch_mode   text        default 'in',
  p_origin_pr            text[]      default null,
  p_origin_pr_mode       text        default 'in',
  p_owner                text[]      default null,
  p_owner_mode           text        default 'in',
  p_sort                 text        default 'updated_at',
  p_cursor_ts            timestamptz default null,
  p_cursor_id            uuid        default null,
  p_limit                integer     default 51,
  p_key_scopes           text[]      default '{}',
  p_key_org_access       text        default 'all',
  p_key_org_ids          uuid[]      default '{}',
  p_min_age_days         integer     default null,
  p_unseen_days          integer     default null,
  p_max_seen_count       integer     default null,
  p_max_read_count       integer     default null,
  p_max_opened_count     integer     default null
)
returns table (
  id             uuid,
  scope          text,
  key            text,
  value          text,
  tags           text[],
  source_agent   text,
  trigger        text,
  created_at     timestamptz,
  updated_at     timestamptz,
  expires_at     timestamptz,
  archived_at    timestamptz,
  origin_repo    text,
  origin_branch  text,
  origin_commit  text,
  origin_pr      integer,
  kind           text,
  host           text,
  seen_count     integer,
  read_count     integer,
  opened_count   integer,
  last_read_at   timestamptz,
  last_opened_at timestamptz,
  org_id         uuid,
  created_by     uuid,
  updated_by     uuid,
  org_name       text,
  org_slug       text,
  total_count    integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^0*[0-9]{1,9}$'
  );
  v_sort text := case when p_sort = 'created_at' then 'created_at' else 'updated_at' end;
begin
  return query execute format($q$
    select
      m.id, m.scope, m.key, m.value, m.tags, m.source_agent, m.trigger,
      m.created_at, m.updated_at, m.expires_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.read_count, m.opened_count, m.last_read_at, m.last_opened_at,
      m.org_id, m.created_by, m.updated_by,
      o.name as org_name, o.slug as org_slug,
      (count(*) over ())::integer as total_count
      from memories m
      left join orgs o on o.id = m.org_id
     where (
             ($1 is null and auth.role() = 'service_role')
             or m.user_id = $1
             or m.org_id in (select lorekit_member_org_ids($1))
           )
       and lorekit_api_token_scope_allowed($32, m.scope)
       and lorekit_api_token_org_allowed($33, $34, m.org_id)
       and (
             case
               when $2 then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and ($3 is null or m.scope = $3)
       and ($4 is null or m.key = $4)
       and ($5 is null or m.key ilike $5 || '%%')
       and ($6 is null or m.key ilike '%%' || $6 || '%%' or m.value ilike '%%' || $6 || '%%')
       and ($7 is null or m.created_at >= $7)
       and ($8 is null or m.created_at < $8)
       and ($9  is null or m.expires_at > $9)
       and ($10 is null or m.expires_at <= $10)
       and lorekit_match_tags(m.tags,          $11, $12)
       and lorekit_match_text(m.source_agent,  $13, $14)
       and lorekit_match_text(m.trigger,       $15, $16)
       and lorekit_match_text(m.kind,          $17, $18)
       and lorekit_match_text(m.host,          $19, $20)
       and lorekit_match_text(m.origin_repo,   $21, $22)
       and lorekit_match_text(m.origin_branch, $23, $24)
       and lorekit_match_int (m.origin_pr,     $25, $26)
       and ($27 is null or case coalesce($28, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all($27)
             )
             else (
               ('personal' = any($27) and m.org_id is null)
               or (m.org_id is not null and o.slug = any($27))
             )
           end)
       and ($35 is null or m.created_at <= now() - ($35 * interval '1 day'))
       and ($36 is null or coalesce(m.last_opened_at, m.created_at) <= now() - ($36 * interval '1 day'))
       and ($37 is null or m.seen_count <= $37)
       and ($38 is null or m.read_count <= $38)
       and ($39 is null or m.opened_count <= $39)
       and (
             $29 is null
             or m.%1$I < $29
             or (m.%1$I = $29 and m.id < $30)
           )
     order by m.%1$I desc, m.id desc
     limit $31
  $q$, v_sort)
  using
    v_actor, coalesce(p_archived, false), p_scope, p_key, p_key_prefix, p_q,
    p_created_since, p_created_until, p_expires_after, p_expires_on_or_before,
    p_tags, p_tags_mode,
    p_source_agent, p_source_agent_mode,
    p_trigger, p_trigger_mode,
    p_kind, p_kind_mode,
    p_host, p_host_mode,
    p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode,
    v_origin_pr, p_origin_pr_mode,
    p_owner, p_owner_mode,
    p_cursor_ts, p_cursor_id,
    greatest(coalesce(p_limit, 51), 1),
    coalesce(p_key_scopes, '{}'::text[]),
    coalesce(p_key_org_access, 'all'),
    coalesce(p_key_org_ids, '{}'::uuid[]),
    p_min_age_days, p_unseen_days, p_max_seen_count, p_max_read_count,
    p_max_opened_count;
end;
$$;

grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer
) to authenticated, service_role;
