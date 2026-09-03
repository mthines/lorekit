-- Fix: `unseen_days` matched EVERY lesson no agent had ever opened.
--
-- 00099 gave `unseen_days` an honest column to key on — `last_opened_at`,
-- bumped only by a targeted MCP/CLI read — and kept 00088's reading of a NULL:
--
--   coalesce(m.last_opened_at, '-infinity') <= now() - (unseen_days * '1 day')
--
-- `-infinity` means "never opened == infinitely stale", so the predicate is
-- VACUOUSLY TRUE for every row with a NULL `last_opened_at`, whatever the
-- threshold. A lesson written yesterday and not yet read by anyone satisfies
-- "not opened in 3650 days".
--
-- Two things make that worse than a rounding error:
--
--   1. `last_opened_at` is new in 00099 and was NOT backfilled, so it is NULL
--      for the ENTIRE pre-existing store. On the day 00099 lands, `unseen_days`
--      therefore selects everything the other two conditions let through —
--      including lore an agent opened an hour before the migration ran.
--   2. Retention policies act on this. 00098 fixed `unseen_days` narrowing
--      NOTHING (a silent no-op); left alone, 00099 converts that into
--      `unseen_days` matching EVERYTHING, which under `mode = 'delete'` is a
--      no-op in the direction that loses data.
--
-- THE FIX: fall back to `created_at`, not `-infinity`. The staleness clock
-- starts when the lesson was written, so "not opened in N days" is literally
-- true of every row returned:
--
--   * never opened, written 7 days ago,  unseen_days 90 → NO match (7 < 90).
--   * never opened, written 200 days ago, unseen_days 90 → match.
--   * opened 100 days ago,                unseen_days 90 → match.
--
-- It also makes the un-backfilled NULL safe by construction: a pre-00099 row
-- falls back to its own creation date, which is the most conservative honest
-- answer available — we do not know when it was last opened, but we do know it
-- has existed, unopened as far as we can tell, since it was written.
--
-- `min_age_days` stays a separate condition rather than becoming redundant:
-- for a never-opened row the two now compose as "at least X days old AND at
-- least Y days un-opened", where Y is the binding constraint when Y > X.
--
-- Forward-only, matching 00098's precedent (which corrected 00088 rather than
-- editing it): 00099 has already been applied to preview databases, so an
-- in-place edit to that file would never re-run there.

-- ── the two functions, re-issued with the created_at fallback ─────────────
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
     and (p_unseen_days is null or coalesce(m.last_opened_at, m.created_at) <= now() - (p_unseen_days * interval '1 day'))
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
       and ($36 is null or coalesce(m.last_opened_at, m.created_at) <= now() - ($36 * interval '1 day'))
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
