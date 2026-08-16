-- ─────────────────────────────────────────────────────────────────────────────
-- 00067 — lorekit_memory_list: the keyset list read as a SQL function
--
-- WHY THIS EXISTS
--
-- 00066 moved the Explorer's filters off the query string and into a JSON body
-- (`POST /memories/list`), because a comma-joined dimension is capped at 2048
-- characters and several dimensions compose a URL the gateway refuses outright
-- (`414 URI too long`, with no LoreKit error envelope at all).
--
-- That fixed the CLIENT → EDGE hop and left the EDGE → POSTGREST hop exactly as
-- it was. `handleList` built its predicates with postgrest-js, whose `.or()` is
-- a QUERY PARAM and whose `.select()` is a GET — so a dimension carrying 200
-- values still composed a ~7 KB `or=` operand on the internal request and still
-- died at the same gateway, now as a `500` instead of a `414`. The wall had
-- moved one hop downstream, which is worse than not having moved: the error is
-- no longer attributable to the thing the caller did.
--
-- A SQL function takes its arguments as real `text[]` parameters over a POST
-- body (`/rest/v1/rpc/…`), so the value set never appears in a URL on either
-- hop. `lorekit_memory_facets` and `lorekit_memory_activity` were already built
-- this way, which is precisely why THEY had no such wall — this brings the list
-- read onto the same footing rather than inventing a third shape for it.
--
-- ONE PREDICATE, STILL
--
-- Both `GET /memories` and `POST /memories/list` call this function. The
-- transports differ in how a request is spelled and in nothing else, which was
-- the safety argument for adding the body form and stays true here — the
-- difference is that the single shared predicate now lives in SQL beside the
-- other two dimension readers instead of in TypeScript beside neither.
--
-- WHAT STAYS IN TYPESCRIPT, AND WHY
--
-- Three values are computed by the caller and passed in already-resolved, so
-- that each is encoded exactly once in this repo (the rule 00063 and 00066 both
-- cite for NOT mirroring `q` and `expiring_within_days` into plpgsql):
--
--   * `p_q`               — the LIKE needle, already escaped by `likeNeedle`.
--                           Postgres LIKE's default escape character is the
--                           backslash, which is what `likeNeedle` emits, so the
--                           pattern applies here unchanged.
--   * `p_key_prefix`      — likewise escaped; this function appends the one
--                           active `%`.
--   * `p_expires_after` / `p_expires_on_or_before`
--                         — the asymmetric "expiring soon" window, already
--                           computed by `expiringWindow`. A second
--                           `now()`-relative boundary in SQL is exactly the
--                           drift those comments warn about.
--
-- DYNAMIC SQL, DELIBERATELY
--
-- The sort column is interpolated as an IDENTIFIER rather than compared with a
-- `case` expression, because `order by case when … then created_at else
-- updated_at end` is not an indexable expression and would give up
-- `memories_scope_updated_at_id_idx` (00061) — the index the keyset page exists
-- to ride. It is the ONLY interpolated fragment, it is chosen from a two-value
-- whitelist below, and every caller-supplied value is bound with `using`. A
-- `p_sort` that is neither known value falls back to `updated_at` rather than
-- raising: the column is validated by `MemorySortSchema` before it ever gets
-- here, so an unknown value means a bug, and a list route should degrade to its
-- default order rather than 500.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function lorekit_memory_list(
  p_user_id              uuid,
  p_archived             boolean     default false,
  p_scope                text        default null,
  p_key                  text        default null,
  -- Already LIKE-escaped by `likeNeedle`; the trailing `%` is added here and is
  -- the only active wildcard.
  p_key_prefix           text        default null,
  -- Already LIKE-escaped by `likeNeedle`; wrapped in `%…%` here.
  p_q                    text        default null,
  p_created_since        timestamptz default null,
  p_created_until        timestamptz default null,
  -- The "expiring soon" window, precomputed by `expiringWindow`: the half-open
  -- `(after, on_or_before]` pair. Both null = the filter is not applied.
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
  -- Keyset cursor: the sort value and id of the last row of the previous page.
  -- Both null = first page. The edge decodes and shape-validates the opaque
  -- cursor (`_shared/api/paginate.ts`) before splitting it into these two.
  p_cursor_ts            timestamptz default null,
  p_cursor_id            uuid        default null,
  -- The caller passes limit + 1 and derives `hasMore` from the overflow row,
  -- exactly as the PostgREST path did — the pagination contract is unchanged.
  p_limit                integer     default 51
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
  -- The `orgs(id,name,slug)` embed, flattened. `shapeMemoryRow` folds these
  -- three back into the nested `org` object the API returns, so the response
  -- body is byte-identical to the PostgREST path's.
  org_name      text,
  org_slug      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  -- Same service-role-gated actor rule as lorekit_memory_facets /
  -- lorekit_memory_activity: a service_role caller may act as a named user, and
  -- anyone else is themselves regardless of what they passed.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  -- `origin_pr` is an integer column and the wire form is text. A non-numeric
  -- entry is DROPPED, never an error: the filter can be built from a
  -- hand-editable URL, and one bad entry should narrow the filter rather than
  -- break the page. Identical to 00066's coercion in the other two readers.
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^[0-9]+$'
  );
  -- Whitelisted identifier — see the header. Anything unrecognised degrades to
  -- the route's default order instead of raising.
  v_sort text := case when p_sort = 'created_at' then 'created_at' else 'updated_at' end;
begin
  return query execute format($q$
    select
      m.id, m.scope, m.key, m.value, m.tags, m.source_agent, m.trigger,
      m.created_at, m.updated_at, m.expires_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.org_id, m.created_by, m.updated_by,
      o.name as org_name, o.slug as org_slug
      from memories m
      -- LEFT: a personal row has no org. Visible org rows are only ever the
      -- caller's own (the visibility predicate admits them via
      -- lorekit_member_org_ids), so o.slug is never a slug they cannot see.
      left join orgs o on o.id = m.org_id
     where (
             ($1 is null and auth.role() = 'service_role')
             or m.user_id = $1
             or m.org_id in (select lorekit_member_org_ids($1))
           )
       -- The archived partition. The live branch additionally hides an expired
       -- row; the archived branch has no liveness guard, which is why the
       -- expiring-soon window below re-states its own lower bound.
       and (
             case
               when $2 then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and ($3 is null or m.scope = $3)
       and ($4 is null or m.key = $4)
       -- Prefix match on key. The needle arrives LIKE-escaped, so the `%%`
       -- appended here is the only active wildcard. Doubled because this
       -- comment is inside the format() template: an undoubled percent there
       -- is read as a type specifier and raises, exactly like the predicates
       -- below.
       and ($5 is null or m.key ilike $5 || '%%')
       -- Substring over key OR value, the `q` filter. Same escaped-needle
       -- contract; both wildcards are added here.
       and ($6 is null or m.key ilike '%%' || $6 || '%%' or m.value ilike '%%' || $6 || '%%')
       -- Half-open [since, until) creation window.
       and ($7 is null or m.created_at >= $7)
       and ($8 is null or m.created_at < $8)
       -- "Expiring soon": `expires_at` in (after, on_or_before]. TWO predicates,
       -- not three — a row with no TTL fails both comparisons on its own,
       -- because `null > x` is null, so no `is not null` guard is needed. Both
       -- are plain conjuncts, so this narrows the partition above rather than
       -- widening it. Range-scans memories_expires_at_idx (00030).
       and ($9  is null or m.expires_at > $9)
       and ($10 is null or m.expires_at <= $10)
       -- The dimension predicates, from the shared helpers (00066), so this
       -- reader cannot drift from lorekit_memory_facets or _activity. AND
       -- across dimensions, OR within one. A null filter is "not filtered".
       and lorekit_match_tags(m.tags,          $11, $12)
       and lorekit_match_text(m.source_agent,  $13, $14)
       and lorekit_match_text(m.trigger,       $15, $16)
       and lorekit_match_text(m.kind,          $17, $18)
       and lorekit_match_text(m.host,          $19, $20)
       and lorekit_match_text(m.origin_repo,   $21, $22)
       and lorekit_match_text(m.origin_branch, $23, $24)
       and lorekit_match_int (m.origin_pr,     $25, $26)
       -- Owner (00064): the computed identity `personal` (org_id null) or the
       -- org slug. Inline rather than a helper because it is not a plain
       -- column — identical expression to the other two readers'.
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
       -- Keyset. Strictly after the previous page's last row in the composite
       -- (sort, id) order below, which is why the tie-break on id is part of
       -- the predicate and not just the ordering.
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
    greatest(coalesce(p_limit, 51), 1);
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer
) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer
) to authenticated, service_role;

comment on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer
) is
  'One keyset page of the memories visible to the EFFECTIVE caller, ordered by
   p_sort desc then id desc, narrowed by every filter GET /memories and
   POST /memories/list accept. Backs BOTH of those routes, so the two transports
   share one predicate. Exists as a FUNCTION rather than a PostgREST query
   because postgrest-js emits filters as URL query params: a dimension carrying
   a few hundred values composed an internal request the gateway refused
   (414 → surfaced as 500), which is the same wall the body transport removed
   one hop upstream. The eight text/tags/int dimension predicates come from
   lorekit_match_text / _tags / _int (00066), so this reader cannot drift from
   lorekit_memory_facets or lorekit_memory_activity; owner stays inline. p_q and
   p_key_prefix arrive already LIKE-escaped and the expiring-soon window arrives
   already computed, so neither escaping nor the now()-relative boundary is
   implemented twice. Callers pass limit + 1 and derive hasMore from the
   overflow row.';
