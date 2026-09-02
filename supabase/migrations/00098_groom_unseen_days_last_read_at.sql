-- Fix: `unseen_days` was checking a column nothing ever wrote.
--
-- 00088 introduced `memories.last_seen_at` for the `unseen_days` retention
-- condition, but its own header said so explicitly: "nothing sets it yet...
-- wiring memory.read/list/search to bump it is deliberately left as a
-- follow-up." That follow-up never landed — `last_seen_at` has no writer
-- anywhere in this codebase, so it is permanently NULL for every row,
-- including rows read constantly. `coalesce(last_seen_at, '-infinity')` then
-- evaluates to true for EVERY memory regardless of actual read activity, so
-- `unseen_days` has been a silent no-op since it shipped: `min_age_days` and
-- `max_seen_count` narrowed a retention view, `unseen_days` narrowed nothing.
--
-- 00084 (which predates 00088) already ships the real signal:
-- `memories.last_read_at`, bumped by `lorekit_record_memory_reads` on every
-- `memory.read`/`list`/`search`/`list_archived` call that actually returns
-- the row. This migration repoints `unseen_days` at that column instead of
-- the dead one, in both callers that evaluate it — `lorekit_groom_candidates`
-- (00088/00093) and `lorekit_memory_list` (00092/00094) — so a saved policy's
-- preview, a run, the nightly sweep, and the Explorer's retention-conditions
-- filter all agree, exactly as they did before this fix, just against a
-- column that is actually written.
--
-- The "never-seen matches any threshold" reading is unchanged: `last_read_at`
-- is NULL until a row is first read (or if it predates 00084's cutover), and
-- `coalesce(last_read_at, '-infinity')` treats that the same way the dead
-- column's NULL always did — this is a data-source fix, not a semantics
-- change, and `grooming.mdx`'s documented contract ("a lesson that has never
-- been read matches at ANY threshold") was already written for this reading.
--
-- `last_seen_at` has no remaining reader or writer after this migration —
-- dropped rather than left as inert dead weight for a future reader to trip
-- over again.
--
-- Both functions keep their EXISTING signatures (no parameter added, removed,
-- or reordered), so `create or replace` is safe here without a preceding
-- `drop function` — unlike 00093/00094, which changed the argument or return
-- shape and had to drop the old overload first.

-- ── lorekit_groom_candidates (00088, extended by 00093) ─────────────────────
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
     and (p_unseen_days is null or coalesce(m.last_read_at, '-infinity'::timestamptz) <= now() - (p_unseen_days * interval '1 day'))
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

-- ── lorekit_memory_list (00067/00069/00092/00094) ───────────────────────────
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
       and ($36 is null or coalesce(m.last_read_at, '-infinity'::timestamptz) <= now() - ($36 * interval '1 day'))
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

-- ── drop the dead column ─────────────────────────────────────────────────
-- No function, view, index, or RLS policy reads or writes `last_seen_at`
-- after the two replacements above — it was never wired to anything in the
-- first place. Dropping it rather than leaving it as inert dead weight.
alter table memories drop column if exists last_seen_at;
