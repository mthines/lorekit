-- ═════════════════════════════════════════════════════════════════════════
-- 00115 — the "Recent read" sort: `lorekit_memory_list(p_sort => 'last_opened_at')`.
--
-- THE GAP. The Explorer can order by Newest (`created_at`) and Most chosen
-- (`opened_count`, 00113), but not by "what did an agent read lately?". The
-- count answers "which lore is used, ever"; it cannot tell a lesson that was
-- fetched forty times last spring from one fetched twice this morning.
--
-- THE COLUMN. `last_opened_at` (00099), not `last_read_at`. `last_read_at`
-- moves on EVERY read — a bulk `memory.list`/`.search` page a lesson merely
-- rode along in, and a human opening the dashboard's detail sheet, included.
-- `last_opened_at` moves only on a TARGETED read from an agent surface
-- (`mcp`/`cli`): an agent deliberately reaching for this one lesson. "Read,
-- not listed" is exactly that column.
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
--
-- NULLS LAST. `last_opened_at` is NULL for a lesson nothing has ever opened,
-- and Postgres puts NULLs FIRST under `desc` — the default ordering would have
-- led "Recent read" with the never-read lessons. The order is therefore
-- `last_opened_at desc nulls last, id desc`, and the never-opened lessons form
-- a tail ordered by id alone.
--
-- A SORT, NOT A FILTER. The never-opened tail stays in the result, so
-- `total_count` is the same under every order — a sort that dropped rows would
-- make the count above the list describe a different population than the
-- unsorted one (00094's contract). "Only lessons opened lately" is already a
-- filter: `p_opened_within_days` (00113).
--
-- THE KEYSET. The cursor is `(last_opened_at, id)` with a NULLABLE first half,
-- so "no cursor" can no longer be read off `p_cursor_ts is null` the way the
-- date sorts read it — a NULL `p_cursor_ts` with a set `p_cursor_id` means
-- "the previous page ended inside the never-opened tail". Under this sort:
--
--     p_cursor_id   is null            → first page
--     p_cursor_ts   is null            → tail only:  last_opened_at is null and id < cursor
--     otherwise                        → the rest of the opened run (strictly
--                                        older, or equal with a smaller id),
--                                        then the whole tail
--
-- NO NEW PARAMETER, NO NEW SIGNATURE. The timestamp half rides in the existing
-- `p_cursor_ts`, the id in `p_cursor_id`; `p_cursor_count` (00113) is not read.
-- The argument list is 00114's exactly, so this is a `create or replace` —
-- grants and the single-overload invariant (§108/§113/§114) are untouched. The
-- revoke/grant pair is restated anyway, so this file alone documents the ACL.
--
-- The three existing orders are unchanged: their keyset predicate and ORDER BY
-- are the 00113 text, now built in the declare block instead of inline.
--
-- §115 in `migrations.test.sql` is the executable proof.
-- ═════════════════════════════════════════════════════════════════════════

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
  p_max_opened_count     integer     default null,
  -- 00113: the Explorer's reverse directions, appended and null-defaulted.
  p_opened_within_days   integer     default null,
  p_min_seen_count       integer     default null,
  p_min_read_count       integer     default null,
  p_min_opened_count     integer     default null,
  -- 00113: the keyset cursor for `p_sort => 'opened_count'`. An integer sort
  -- needs an integer cursor; `p_cursor_ts` keeps serving the timestamp sorts —
  -- since 00115 including the nullable `last_opened_at`.
  p_cursor_count         integer     default null,
  -- 00114: labels the row must carry NONE of — an always-applied conjunct,
  -- independent of p_tags/p_tags_mode, so "tagged a AND NOT tagged b" is
  -- expressible. Appended, null-defaulted: null = not filtered.
  p_exclude_tags         text[]      default null
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
  -- 00113: `opened_count` joins the two date sorts; 00115: `last_opened_at`.
  -- Anything else still falls back to `updated_at`, so an unknown value cannot
  -- reach the format() below.
  v_sort text := case
    when p_sort in ('created_at', 'opened_count', 'last_opened_at') then p_sort else 'updated_at'
  end;
  -- Which bound parameter carries the keyset value: the integer cursor ($44)
  -- for the count sort, the timestamp cursor ($29) for the others. A fixed
  -- placeholder chosen here, never caller text, so splicing it is safe.
  v_cursor text := case when v_sort = 'opened_count' then '$44' else '$29' end;
  -- The keyset predicate and the ORDER BY, per sort. Built from fixed text and
  -- `v_sort` (whitelisted above, quoted with %I) only.
  --
  -- 00115: `last_opened_at` is NULLABLE, so it cannot use the shared shape —
  -- NULLs would sort first under `desc`, and `col < cursor` is never true for
  -- a NULL row, so the never-opened tail would be unreachable past page one.
  -- See the header for the three cursor states.
  v_keyset text := case
    when v_sort = 'last_opened_at' then
      $k$(
             $30 is null
             or case
                  when $29 is null then m.last_opened_at is null and m.id < $30
                  else m.last_opened_at < $29
                       or (m.last_opened_at = $29 and m.id < $30)
                       or m.last_opened_at is null
                end
           )$k$
    else format(
      '(%2$s is null or m.%1$I < %2$s or (m.%1$I = %2$s and m.id < $30))',
      v_sort, v_cursor)
  end;
  v_order text := case
    when v_sort = 'last_opened_at' then 'm.last_opened_at desc nulls last, m.id desc'
    else format('m.%I desc, m.id desc', v_sort)
  end;
  -- Resolved once per call so lorekit_match_retention stays immutable (00108).
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
  -- 00113: the "opened within N days" lower bound, resolved once per call for
  -- the same reason as the two cutoffs above.
  v_opened_since timestamptz := case
    when p_opened_within_days is null then null else now() - (p_opened_within_days * interval '1 day')
  end;
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
       and lorekit_match_tags(m.tags,          $45, 'none')
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
       and lorekit_match_retention(
             m.created_at, m.last_opened_at, m.seen_count, m.read_count, m.opened_count,
             $35, $36, $37, $38, $39,
             $40, $41, $42, $43
           )
       and %1$s
     order by %2$s
     limit $31
  $q$, v_keyset, v_order)
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
    v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count,
    p_max_opened_count,
    v_opened_since, p_min_seen_count, p_min_read_count, p_min_opened_count,
    p_cursor_count,
    p_exclude_tags;
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) is
  'The keyset-paginated memory list behind GET /memories and POST /memories/list.
   Sorts by updated_at (default), created_at, opened_count (00113) or
   last_opened_at (00115) — each descending with id as the tie-break;
   last_opened_at is NULLS LAST, so never-opened lessons trail. p_cursor_ts
   carries the timestamp sorts'' keyset value (NULL under last_opened_at with a
   set p_cursor_id = inside the never-opened tail) and p_cursor_count the count
   sort''s. Applies the five retention thresholds and the Explorer''s reverse
   directions through the shared lorekit_match_retention, so its total_count
   agrees with _facets, _activity and _pivot under the same parameters.
   p_exclude_tags (00114): the row carries none of these labels, ANDed with
   whatever p_tags/p_tags_mode ask.';
