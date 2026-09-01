-- `unseen_days` should mean "no agent has deliberately opened this lesson in
-- N days" — not "nothing touched this row", which is what `last_read_at`
-- (repointed here from the dead `last_seen_at` by 00096) actually measures.
--
-- THE GAP 00096 LEFT: `last_read_at` is bumped by `lorekit_record_memory_reads`
-- for EVERY read that returns a row, `targeted` (`memory.read` / `GET /:id`)
-- OR `bulk` (`memory.list` / `.search` / `.list_archived`) — and `GET /:id` is
-- the SAME route the web dashboard's LessonDetailSheet calls to render a
-- lesson for a human, plus whatever the CLI's remote `read`/`show` command
-- calls. So `last_read_at` moves when: an agent asks for this exact lesson
-- (the signal `unseen_days` wants), a bulk `list`/`search` happens to include
-- it (no one "saw" it — it rode along in a results page), or a human opens the
-- dashboard's detail sheet (browsing your own lore is not consuming it — the
-- same reasoning migration 00054 already applied to `lorekit_read_activity`).
-- A policy set to "unseen 90d" was therefore satisfied by the Explorer being
-- opened, not by an agent reading the lesson back.
--
-- THE FIX: a new, narrower column — `memories.last_opened_at` — bumped ONLY
-- when a read is BOTH `read_kind = 'targeted'` AND attributed to an agent
-- surface (`client` = `mcp` or `cli`, the `X-LoreKit-Client` / MCP-transport
-- vocabulary from migration 00054). `unseen_days` in both
-- `lorekit_groom_candidates` and `lorekit_memory_list` now reads THIS column
-- instead of `last_read_at`.
--
-- `last_read_at`/`read_count` are UNTOUCHED and keep their existing, broader
-- meaning (any read, from any surface, targeted or bulk) — that is the
-- dashboard's "Consumption" row, and it stays useful precisely because it
-- answers a different question ("has this been read at all") than
-- `last_opened_at` ("has an agent deliberately reached for this one lesson").
-- Both are worth keeping: a lesson can ride along in list pages constantly
-- while never once being individually opened, or vice versa.
--
-- `lorekit_record_memory_reads` gains a trailing `p_client text default null`
-- — additive, so every existing caller that omits it is unaffected and keeps
-- recording `read_count`/`last_read_at`/`memory_read_daily` exactly as before.
-- Adding a parameter changes the signature, so the old overload is DROPped
-- first, matching 00093/00094/00054's precedent.

-- ── the column ──────────────────────────────────────────────────────────────
alter table memories add column if not exists last_opened_at timestamptz;

comment on column memories.last_opened_at is
  'Last time this exact memory was individually retrieved by an agent over
   MCP or the CLI (read_kind = targeted, client in (mcp, cli)) — migration
   00097. NULL means never targeted-opened by an agent. Distinct from
   last_read_at (migration 00084/00096), which also moves on a bulk
   list/search appearance or a human viewing the web dashboard.';

-- ── writer: add a trailing p_client, gate last_opened_at on it ─────────────
drop function if exists lorekit_record_memory_reads(uuid[], text);

create or replace function lorekit_record_memory_reads(
  p_memory_ids uuid[],
  p_read_kind  text,
  p_client     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_memory_ids is null or array_length(p_memory_ids, 1) is null then
    return;
  end if;

  -- ONE statement for every id, not one per id — the hot-path requirement a
  -- bulk `list` returning 31 rows imposes. `unnest` turns the array into a rowset
  -- the UPDATE can join against directly.
  update memories m
     set read_count = m.read_count + 1,
         last_read_at = now(),
         -- Narrower than the two columns above: only a TARGETED read
         -- attributed to an agent surface counts as "opened". `p_client` is
         -- validated app-side (`parseUsageClient`) before it reaches here, so
         -- this is a closed two-value check, not a free-text comparison.
         last_opened_at = case
           when p_read_kind = 'targeted' and p_client in ('mcp', 'cli')
             then now()
           else m.last_opened_at
         end
    from unnest(p_memory_ids) as ids(id)
   where m.id = ids.id;

  -- Upsert today's rollup row per memory — one INSERT, conflict-aggregated,
  -- same shape as the update above. `current_date` is UTC-anchored the same
  -- way `usage_events`' other date_trunc'd reads are (`at time zone 'UTC'`),
  -- so a rollup day boundary agrees with every other UTC-bucketed series in
  -- this schema.
  insert into memory_read_daily (memory_id, day, read_kind, count)
  select ids.id, (now() at time zone 'UTC')::date, p_read_kind, 1
    from unnest(p_memory_ids) as ids(id)
  on conflict (memory_id, day, read_kind)
  do update set count = memory_read_daily.count + 1;
exception
  when others then
    -- Never let a counter write break the read it is measuring.
    return;
end;
$$;

revoke execute on function lorekit_record_memory_reads(uuid[], text, text) from public, anon;
grant execute on function lorekit_record_memory_reads(uuid[], text, text) to authenticated, service_role;

comment on function lorekit_record_memory_reads(uuid[], text, text) is
  'Increments memories.read_count/.last_read_at and today''s memory_read_daily
   row (UTC day, keyed by read_kind) for every memory id a read call actually
   returned, in ONE statement regardless of array size. Also sets
   memories.last_opened_at (migration 00097) when read_kind = targeted AND
   client in (mcp, cli) -- an agent deliberately reaching for this one lesson,
   as opposed to a bulk list/search appearance or a dashboard view. read_kind
   is targeted (memory.read / GET /:id) or bulk (memory.list / memory.search /
   memory.list_archived). Fail-safe: never throws, so a counter-write failure
   cannot fail the read it measures. No-op on a null/empty array.';

-- ── unseen_days now reads last_opened_at, not last_read_at ─────────────────
-- Both functions keep their EXISTING signatures (no parameter added, removed,
-- or reordered), so `create or replace` is safe without a preceding
-- `drop function`.

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
     and (p_unseen_days is null or coalesce(m.last_opened_at, '-infinity'::timestamptz) <= now() - (p_unseen_days * interval '1 day'))
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
  p_max_seen_count       integer     default null
)
returns table (
  id            uuid,
  scope         text,
  key           text,
  value         text,
  tags          text[],
  source_agent  text,
  trigger       text,
  created_at    timestamptz,
  updated_at    timestamptz,
  expires_at    timestamptz,
  archived_at   timestamptz,
  origin_repo   text,
  origin_branch text,
  origin_commit text,
  origin_pr     integer,
  kind          text,
  host          text,
  seen_count    integer,
  org_id        uuid,
  created_by    uuid,
  updated_by    uuid,
  org_name      text,
  org_slug      text,
  total_count   integer
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
       and ($36 is null or coalesce(m.last_opened_at, '-infinity'::timestamptz) <= now() - ($36 * interval '1 day'))
       and ($37 is null or m.seen_count <= $37)
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
    p_min_age_days, p_unseen_days, p_max_seen_count;
end;
$$;

grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer
) to authenticated, service_role;
