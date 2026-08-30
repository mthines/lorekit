-- ═════════════════════════════════════════════════════════════════════════
-- Owner as a first-class filter DIMENSION (00064).
--
-- WHAT CHANGES: ownership (personal vs a shared org) was the ONE Explorer
-- filter narrowed CLIENT-side — a separate `OwnershipFilterBar` over the loaded
-- pages, so it could not agree with the server-filtered list, the drill-down
-- facet counts, or the stat header, and it silently missed rows past the page
-- the browser happened to hold. This folds it into the SAME "OR within a
-- dimension, AND across dimensions" machinery every other dimension already
-- uses (00057 facets, 00063 activity, GET /memories), as a new `owner` facet.
--
-- THE OWNER IDENTITY of a row is `personal` when `org_id is null`, else the
-- owning org's SLUG (stable, unlike its uuid or its display name). It is
-- resolved by a LEFT JOIN to `orgs`; a personal row has no org and takes the
-- literal `personal`. Slugs resolve against the caller's member orgs ONLY —
-- which the visibility predicate already guarantees, since an org-owned row is
-- visible solely through the `lorekit_member_org_ids` branch, so its joined
-- slug is always one of the caller's own orgs.
--
-- THE OWNER PREDICATE (mirrored byte-for-byte in both functions and in the
-- GET /memories handler):
--   in  → ('personal' = any(p_owner) AND org_id is null)
--          OR (org_id is not null AND o.slug = any(p_owner))
--   nin → identity is not null AND identity <> all(p_owner)   -- identity above
-- The `nin` guard mirrors every other scalar dimension's `(col is not null AND
-- col <> all(...))` shape; the computed identity is never null in practice
-- (personal → 'personal', visible org row → its slug), but the guard keeps the
-- three-valued-logic behaviour identical to its neighbours.
--
-- SELF-EXCLUSION, as for every drill-down dimension in 00057: the `owner` facet
-- cell applies every OTHER dimension's flag but NOT `ok_owner`, so standing on
-- `owner=personal` still lists the org you could switch to; and every OTHER
-- dimension's cell now additionally requires `ok_owner`, so picking an owner
-- narrows their counts to the list's set.
--
-- Forward-only. Both functions are DROPped at their 00057 / 00063 signatures
-- and recreated with `p_owner text[]` / `p_owner_mode text` APPENDED at the end
-- (defaulted, so a positional caller passing only the earlier args is
-- unaffected, and a bare call is byte-for-byte the prior behaviour). The DROP of
-- the exact prior signature is deliberate — leaving it in place would make the
-- named-arg handler calls ambiguous between two overloads.
-- ═════════════════════════════════════════════════════════════════════════

-- ── lorekit_memory_facets ────────────────────────────────────────────────────

drop function if exists lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text
);

create or replace function lorekit_memory_facets(
  p_user_id            uuid,
  p_archived           boolean default false,
  p_scope              text    default null,
  p_tags               text[]  default null,
  p_tags_mode          text    default 'any',
  p_source_agent       text[]  default null,
  p_source_agent_mode  text    default 'in',
  p_trigger            text[]  default null,
  p_trigger_mode       text    default 'in',
  p_kind               text[]  default null,
  p_kind_mode          text    default 'in',
  p_host               text[]  default null,
  p_host_mode          text    default 'in',
  p_origin_repo        text[]  default null,
  p_origin_repo_mode   text    default 'in',
  p_origin_branch      text[]  default null,
  p_origin_branch_mode text    default 'in',
  p_origin_pr          text[]  default null,
  p_origin_pr_mode     text    default 'in',
  -- Owner dimension (00064). `personal` plus one slug per member org with
  -- visible rows. All optional: null/absent = not filtered.
  p_owner              text[]  default null,
  p_owner_mode         text    default 'in'
)
returns table (facet text, value text, count bigint)
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
     where x ~ '^[0-9]+$'
  );
begin
  return query
  with base as (
    select
      m.tags, m.source_agent, m.trigger, m.kind, m.host,
      m.origin_repo, m.origin_branch, m.origin_pr,
      m.org_id, o.slug as org_slug,
      (p_tags is null or case coalesce(p_tags_mode, 'any')
         when 'all'  then m.tags @> p_tags
         when 'none' then not (m.tags && p_tags)
         else m.tags && p_tags
       end) as ok_tag,
      (p_source_agent is null or case coalesce(p_source_agent_mode, 'in')
         when 'nin' then (m.source_agent is not null and m.source_agent <> all(p_source_agent))
         else m.source_agent = any(p_source_agent)
       end) as ok_source_agent,
      (p_trigger is null or case coalesce(p_trigger_mode, 'in')
         when 'nin' then (m.trigger is not null and m.trigger <> all(p_trigger))
         else m.trigger = any(p_trigger)
       end) as ok_trigger,
      (p_kind is null or case coalesce(p_kind_mode, 'in')
         when 'nin' then (m.kind is not null and m.kind <> all(p_kind))
         else m.kind = any(p_kind)
       end) as ok_kind,
      (p_host is null or case coalesce(p_host_mode, 'in')
         when 'nin' then (m.host is not null and m.host <> all(p_host))
         else m.host = any(p_host)
       end) as ok_host,
      (p_origin_repo is null or case coalesce(p_origin_repo_mode, 'in')
         when 'nin' then (m.origin_repo is not null and m.origin_repo <> all(p_origin_repo))
         else m.origin_repo = any(p_origin_repo)
       end) as ok_origin_repo,
      (p_origin_branch is null or case coalesce(p_origin_branch_mode, 'in')
         when 'nin' then (m.origin_branch is not null and m.origin_branch <> all(p_origin_branch))
         else m.origin_branch = any(p_origin_branch)
       end) as ok_origin_branch,
      (v_origin_pr is null or case coalesce(p_origin_pr_mode, 'in')
         when 'nin' then (m.origin_pr is not null and m.origin_pr <> all(v_origin_pr))
         else m.origin_pr = any(v_origin_pr)
       end) as ok_origin_pr,
      -- Owner: the computed identity is `personal` (org_id null) or the org slug.
      (p_owner is null or case coalesce(p_owner_mode, 'in')
         when 'nin' then (
           (case when m.org_id is null then 'personal' else o.slug end) is not null
           and (case when m.org_id is null then 'personal' else o.slug end) <> all(p_owner)
         )
         else (
           ('personal' = any(p_owner) and m.org_id is null)
           or (m.org_id is not null and o.slug = any(p_owner))
         )
       end) as ok_owner
      from memories m
      -- A personal row has no org, so this is a LEFT join; org rows resolve to
      -- their slug. Visible org rows are always the caller's own orgs (the
      -- visibility predicate below admits them only via lorekit_member_org_ids),
      -- so `o.slug` is never a slug the caller cannot see.
      left join orgs o on o.id = m.org_id
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and (
             case
               when p_archived then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and (p_scope is null or m.scope = p_scope)
  ), cells as (
    select 'tag'::text as facet, t.tag as value
      from base b
      cross join lateral unnest(b.tags) as t(tag)
     where b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'source_agent', b.source_agent from base b
     where b.ok_tag and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'trigger', b.trigger from base b
     where b.ok_tag and b.ok_source_agent and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'kind', b.kind from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'host', b.host from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_repo', b.origin_repo from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_branch', b.origin_branch from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_pr', b.origin_pr::text from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_owner
    union all
    -- Owner is the ONE dimension self-excluded here (every other flag, NOT
    -- ok_owner), so a drilled-in owner still lists the alternative owner.
    select 'owner', case when b.org_id is null then 'personal' else b.org_slug end from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
  )
  select c.facet, c.value, count(*) as count
    from cells c
   where c.value is not null
     and btrim(c.value) <> ''
   group by c.facet, c.value
   order by c.facet asc, count(*) desc, c.value asc;
end;
$$;

revoke execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr,
   owner) over the partition selected by p_archived, visible to the EFFECTIVE
   caller. `owner` (00064) is `personal` for org_id-null rows, else the org
   slug. Counts are DRILL-DOWN (00057): each dimension is counted with every
   OTHER active filter applied but not its own (self-exclusion), so the numbers
   match what adding that value would yield. With no filters supplied the result
   is 00052''s global catalog plus the owner dimension. Same service-role-gated
   actor rule and ordering as lorekit_memory_tags.';

-- ── lorekit_memory_activity ──────────────────────────────────────────────────

drop function if exists lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
);

create or replace function lorekit_memory_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  p_scope              text   default null,
  p_tags               text[] default null,
  p_tags_mode          text   default 'any',
  p_source_agent       text[] default null,
  p_source_agent_mode  text   default 'in',
  p_trigger            text[] default null,
  p_trigger_mode       text   default 'in',
  p_kind               text[] default null,
  p_kind_mode          text   default 'in',
  p_host               text[] default null,
  p_host_mode          text   default 'in',
  p_origin_repo        text[] default null,
  p_origin_repo_mode   text   default 'in',
  p_origin_branch      text[] default null,
  p_origin_branch_mode text   default 'in',
  p_origin_pr          text[] default null,
  p_origin_pr_mode     text   default 'in',
  -- Owner dimension (00064) — the SAME predicate as lorekit_memory_facets and
  -- GET /memories, so the stat header agrees with the list under an owner pill.
  p_owner              text[] default null,
  p_owner_mode         text   default 'in'
)
returns table (bucket timestamptz, scope text, count bigint)
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
     where x ~ '^[0-9]+$'
  );
begin
  if p_bucket is null or p_bucket not in ('hour', 'day') then
    raise exception 'invalid bucket %, expected hour or day', p_bucket
      using errcode = '22023';
  end if;

  return query
    select date_trunc(p_bucket, m.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           m.scope,
           count(*) as count
      from memories m
      -- LEFT join for the owner predicate — a personal row has no org (00064).
      left join orgs o on o.id = m.org_id
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_since is null or m.created_at >= p_since)
       and (p_until is null or m.created_at <  p_until)
       and (p_scope is null or m.scope = p_scope)
       and (p_tags is null or case coalesce(p_tags_mode, 'any')
             when 'all'  then m.tags @> p_tags
             when 'none' then not (m.tags && p_tags)
             else m.tags && p_tags
           end)
       and (p_source_agent is null or case coalesce(p_source_agent_mode, 'in')
             when 'nin' then (m.source_agent is not null and m.source_agent <> all(p_source_agent))
             else m.source_agent = any(p_source_agent)
           end)
       and (p_trigger is null or case coalesce(p_trigger_mode, 'in')
             when 'nin' then (m.trigger is not null and m.trigger <> all(p_trigger))
             else m.trigger = any(p_trigger)
           end)
       and (p_kind is null or case coalesce(p_kind_mode, 'in')
             when 'nin' then (m.kind is not null and m.kind <> all(p_kind))
             else m.kind = any(p_kind)
           end)
       and (p_host is null or case coalesce(p_host_mode, 'in')
             when 'nin' then (m.host is not null and m.host <> all(p_host))
             else m.host = any(p_host)
           end)
       and (p_origin_repo is null or case coalesce(p_origin_repo_mode, 'in')
             when 'nin' then (m.origin_repo is not null and m.origin_repo <> all(p_origin_repo))
             else m.origin_repo = any(p_origin_repo)
           end)
       and (p_origin_branch is null or case coalesce(p_origin_branch_mode, 'in')
             when 'nin' then (m.origin_branch is not null and m.origin_branch <> all(p_origin_branch))
             else m.origin_branch = any(p_origin_branch)
           end)
       and (v_origin_pr is null or case coalesce(p_origin_pr_mode, 'in')
             when 'nin' then (m.origin_pr is not null and m.origin_pr <> all(v_origin_pr))
             else m.origin_pr = any(v_origin_pr)
           end)
       -- Owner: `personal` for org_id-null rows, else the org slug (00064).
       and (p_owner is null or case coalesce(p_owner_mode, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all(p_owner)
             )
             else (
               ('personal' = any(p_owner) and m.org_id is null)
               or (m.org_id is not null and o.slug = any(p_owner))
             )
           end)
     group by 1, m.scope
     order by 1 asc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, visible to the EFFECTIVE caller, narrowed by the
   optional scope + dimension filters (00063) plus the owner dimension (00064,
   `personal` / org slug) — the SAME predicate as GET /memories and
   lorekit_memory_facets, so the stat header agrees with the list. With no
   filters supplied the result is byte-for-byte 00051''s.';
