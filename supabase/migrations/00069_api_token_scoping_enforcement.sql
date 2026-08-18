-- ═════════════════════════════════════════════════════════════════════════
-- API token scoping, part 2 of 2: the SQL-side enforcement.
--
-- 00067 added the data model (`api_tokens.scopes` / `org_access` / `org_ids`)
-- and the two predicates, and enforced nothing. This migration teaches the SEVEN
-- functions that the transports CANNOT stand in front of — two mutation gates
-- and five per-scope aggregates — and re-issues one of 00067's own predicates:
--
--   1. `memory_write` — the last unbypassable gate on the write path, on BOTH
--      axes. The edge holds the service-role key, so every check above this
--      function is advisory by construction; and the scope→org BINDING lives in
--      here, where no transport can see it. 00067 decision 4 says the key
--      restriction beats the binding, and this is the only place that sentence
--      can be true.
--
--   2. `lorekit_memory_scopes` — the scope catalog. Filtering reads without
--      filtering this one would leave scoping leaking exactly what it hides: a
--      scope string IS a repo or project name, so a key narrowed to one repo
--      could still enumerate every repo on the account.
--
--   3. `lorekit_memory_activity`, 4. `lorekit_read_activity`, 5. `lorekit_memory_tags`
--      and 6. `lorekit_memory_facets` — the other four per-scope aggregates. Each
--      returns one row per scope, label or repo NAME, and `_facets`'s
--      `origin_repo` is a repository name outright — so narrowing only
--      `lorekit_memory_scopes` would move the leak to the charts and the filter
--      pills rather than close it. `lorekit_usage_stats` is deliberately NOT in
--      this list: it rolls up by the bounded `scope_type`, never a name.
--
--   7. `memory_delete` — the delete twin of `memory_write`. Its org branch picks
--      its own rows, so no transport-side filter can reach them.
--
--   8. `lorekit_memory_list` — the list read itself. 00067 (merged to main
--      while this branch was open) moved it out of PostgREST and into a SQL
--      function, which took the whole family out of `applyRestTenantScope`'s
--      reach. Ungated it would be the one read a scoped key still sees whole.
--
-- And `lorekit_api_token_scope_allowed` itself is re-issued (body section 8) so
-- a stored pattern outside `SCOPE_PATTERN`'s shape is dropped rather than
-- widening the key.
--
-- All of them take the calling key's restriction as DEFAULTED trailing parameters, so
-- every existing caller — a dashboard JWT, the Node `mcp-server`, CI on the
-- service role — keeps the pre-00068 behaviour with no call-site change, and an
-- unscoped key is byte-for-byte unaffected.
--
-- ── Why the parameters are trustworthy ────────────────────────────────────
--
-- "Caller says which key it is" would be no boundary at all. It is safe here
-- for the same reason `p_user_id` is safe in 00046: the ONLY caller that can
-- reach these functions with a restriction attached is the edge, on a verified
-- service-role connection, and it reads the restriction out of `api_tokens` by
-- token hash microseconds earlier. An `authenticated` caller cannot forge a
-- WIDER restriction than it already has, because the widest possible value is
-- the default — passing `('all', '{}')` is what every non-key caller already
-- does. The failure mode of a forged value is therefore self-denial.
--
-- ── Why the changed signatures are DROPped first ──────────────────────────
--
-- Adding a defaulted parameter does not replace the old signature, it creates
-- an OVERLOAD — and then every existing call becomes ambiguous. Forward-only,
-- drop-then-create, grants re-issued (the 00026 / 00059 pattern).
-- ═════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. memory_write
--
-- Carried over verbatim from 00059 apart from the two new parameters and the
-- two `lorekit_api_token_org_allowed` guards they feed — the org branch (an
-- explicitly named org) and the binding branch (an auto-routed one).
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text
);

create or replace function memory_write(
  p_user_id       uuid,
  p_scope         text,
  p_key           text,
  p_value         text,
  p_tags          text[]      default '{}',
  p_source_agent  text        default null,
  p_trigger       text        default null,
  p_created_at    timestamptz default null,
  p_org_slug      text        default null,
  p_ttl_seconds   integer     default null,
  p_clear_ttl     boolean     default false,
  p_origin_repo   text        default null,
  p_origin_branch text        default null,
  p_origin_commit text        default null,
  p_origin_pr     integer     default null,
  p_kind          text        default null,
  p_host          text        default null,
  -- The CALLING KEYs restriction — BOTH axes, defaulted so every existing
  -- caller (JWT, the Node path, CI service-role) keeps the pre-00068 behaviour
  -- untouched. The scope allowlist is here for the same reason the tenancy is:
  -- the edge holds the service-role key, so the dispatchers refusal is
  -- advisory, and this is the last gate a write cannot go around.
  p_key_scopes     text[]     default '{}',
  p_key_org_access text       default 'all',
  p_key_org_ids    uuid[]     default '{}'
)
returns table (
  id               uuid,
  created_at       timestamptz,
  inserted         boolean,
  org_routed       boolean,
  binding_org_slug text,
  expires_at       timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  v_org_id       uuid;
  v_binding_org  uuid;
  v_binding_slug text;
  v_expires_at   timestamptz;
  v_ttl_action   text := 'keep';
begin
  -- The scope allowlist, checked FIRST and for every branch. Both transports
  -- already refuse a named scope outside the allowlist, but both run on the
  -- service-role client, so those refusals are advisory by construction — this
  -- is the one place on the write path that a caller cannot route around.
  -- LK002, the same code the org denial raises, so `translateDbError` answers
  -- the REST caller a 403 and the MCP caller a forbidden error without a second
  -- mapping.
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  if p_clear_ttl then
    v_ttl_action := 'clear';
  elsif p_ttl_seconds is not null then
    if p_ttl_seconds < 1 or p_ttl_seconds > 31536000 then
      raise exception using errcode = 'P0001',
        message = format('ttl_seconds must be between 1 and 31536000, got %s', p_ttl_seconds);
    end if;
    v_expires_at  := now() + (p_ttl_seconds * interval '1 second');
    v_ttl_action  := 'set';
  end if;

  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug and o.deleted_at is null;
    if v_org_id is null then
      raise exception using errcode = 'P0001', message = format('unknown_org: %s', p_org_slug);
    end if;
    if not lorekit_org_can(p_user_id, v_org_id, 'write') then
      raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s', p_org_slug);
    end if;
    -- Defence in depth. The transport already refuses a key writing into an
    -- org outside its tenancy, but this RPC is the LAST gate that cannot be
    -- bypassed: the edge holds the service-role key, so every check above it
    -- is advisory by construction.
    if not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_org_id) then
      raise exception using errcode = 'LK002',
        message = format('key_org_denied: org=%s', p_org_slug);
    end if;
  else
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where b.scope = p_scope and o.deleted_at is null;

    -- 00067 decision 4: THE KEY WINS OVER THE BINDING. Auto-routing is a
    -- convenience; the keys tenancy is an authorization boundary, and a
    -- boundary a convenience can widen is not one. A key that may not reach
    -- the bound org falls back to a PERSONAL write — the same graceful
    -- outcome a non-member already gets, and `binding_org_slug` still comes
    -- back so the caller can surface the same actionable notice.
    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write')
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_binding_org) then
      v_org_id := v_binding_org;
    end if;
  end if;

  if v_org_id is not null then
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  elsif p_user_id is null then
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  else
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;
  end if;
end;
$$;

-- Grants re-issued after the DROP. The role list is carried over UNCHANGED from
-- 00059, `anon` included. That grant looks anomalous next to 00046, which
-- revoked `anon` from `memory_delete` and the four archive/purge RPCs and did
-- not touch `memory_write` — but tightening it here would be an unrelated
-- behaviour change smuggled into an authorization migration, and this function
-- is reachable on the BYOD/anon path. Left exactly as found, flagged for its
-- own change.
grant execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text, text[], text, uuid[]
) to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. lorekit_memory_scopes
--
-- Carried over verbatim from 00065 apart from the three new parameters and the
-- two predicate calls in the WHERE clause.
--
-- The org predicate is applied to `m.org_id`, which is NULL for a personal row —
-- and `lorekit_api_token_org_allowed` answers true for NULL under every tenancy,
-- so a `personal` key still sees its own scopes and only loses the org ones.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists lorekit_memory_scopes(uuid);

create or replace function lorekit_memory_scopes(
  p_user_id uuid,
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (scope text, count bigint, last_activity timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The RETURNS TABLE columns are also plpgsql OUT variables, so an unqualified
-- reference to any of them inside the query would be ambiguous. Every reference
-- below is table-qualified, and this directive makes the column win regardless.
#variable_conflict use_column
declare
  -- Honour a caller-supplied p_user_id only on a verified service-role
  -- connection (the edge resolves the token owner and passes it); an
  -- authenticated caller is pinned to its own auth.uid(), closing the
  -- cross-user scope-name enumeration. A NULL actor under service-role is the
  -- CI escape hatch, preserved by the first visibility branch below.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  return query
    select m.scope, count(*) as count, max(m.created_at) as last_activity
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       -- The calling key's own restriction, on top of the caller's visibility.
       -- Never instead of it: a key can only ever NARROW what its owner can
       -- already see, so these are ANDed with the predicate above and the
       -- account boundary stays exactly where 00046 put it.
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
     group by m.scope
     order by count(*) desc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_scopes(uuid, text[], text, uuid[]) from public, anon;
grant  execute on function lorekit_memory_scopes(uuid, text[], text, uuid[])
  to authenticated, service_role;

comment on function lorekit_memory_scopes(uuid, text[], text, uuid[]) is
  'Per-scope active counts and last activity visible to the EFFECTIVE caller,
   further narrowed by the CALLING KEY''s scope allowlist and tenancy (00067).
   Ordered by count desc then scope asc (matching lorekit_memory_tags). Actor
   resolved by the 00046/00041 service-role-gated rule: a caller-supplied
   p_user_id is honoured only on a verified service-role connection, otherwise
   auth.uid() wins — so an authenticated caller can never enumerate another
   user''s scope names, and a scoped key can never enumerate scope names outside
   its allowlist (a scope string IS a repo or project name). p_user_id IS NULL
   under service-role is the CI escape hatch. The key parameters default to
   unrestricted, so a non-key caller is unaffected. last_activity is
   max(created_at) over the same counted rows.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. lorekit_memory_activity
-- 4. lorekit_read_activity
--
-- The two remaining per-scope catalogs. `lorekit_memory_scopes` above is not
-- the only endpoint that returns one row per scope name: `GET /memories/activity`
-- and `GET /memories/read-activity` do too, and a scope string IS a repo or
-- project name — so narrowing the catalog while leaving the two activity series
-- unnarrowed would let a key restricted to one repo enumerate every repo on the
-- account through the charts instead of through the catalog.
--
-- Same shape as `lorekit_memory_scopes`: defaulted trailing parameters, the two
-- 00067 predicates ANDed on top of the caller's own visibility (never instead
-- of it), and an unscoped key byte-for-byte unaffected. Narrowed HERE rather
-- than post-filtered in the edge for the reason the catalog is: the rows are
-- aggregates, so dropping rows afterwards would report counts that do not add
-- up, and a truncated response would under-report silently.
--
-- `lorekit_read_activity` reads `usage_events`, which has no `org_id`, so it
-- takes the scope allowlist only — its visibility is already self-only (usage
-- is a per-user ledger, never org-shared) and there is no org axis to narrow.
-- Its `scope` column is NULLABLE (an unattributable read); a NULL scope names
-- nothing and so leaks nothing, and `lorekit_api_token_scope_allowed` is given
-- the explicit NULL pass below so the account total stays complete rather than
-- silently dropping every pre-00058 row for a scoped key.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
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
  p_owner              text[] default null,
  p_owner_mode         text   default 'in',
  -- The CALLING KEY's restriction (00067), defaulted to unrestricted.
  p_key_scopes         text[] default '{}',
  p_key_org_access     text   default 'all',
  p_key_org_ids        uuid[] default '{}'
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
  -- `origin_pr` is an INTEGER column: coerce the digits-only list numerically so
  -- this route matches GET /memories on the same input (00057's rationale). A
  -- non-numeric entry is dropped; a list reducing to empty applies no filter.
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
       -- The calling key's own restriction, ANDed on top of the caller's
       -- visibility and never instead of it (the lorekit_memory_scopes rule).
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_since is null or m.created_at >= p_since)
       and (p_until is null or m.created_at <  p_until)
       -- Scope is a hard filter, always applied (00057's treatment).
       and (p_scope is null or m.scope = p_scope)
       -- Dimension filters — AND across, OR within, from the shared predicates
       -- (00066) so the semantics cannot drift from lorekit_memory_facets. No
       -- self-exclusion here: a straight count applies every one directly.
       and lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)
       and lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)
       and lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)
       and lorekit_match_text(m.kind,          p_kind,          p_kind_mode)
       and lorekit_match_text(m.host,          p_host,          p_host_mode)
       and lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)
       and lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode)
       and lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)
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
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, visible to the EFFECTIVE caller, narrowed by the
   optional scope + dimension filters (00063) plus the owner dimension (00064,
   `personal` / org slug), and further narrowed by the CALLING KEY''s scope
   allowlist and tenancy (00067) — this series returns one row per scope NAME,
   so leaving it unnarrowed would leak exactly what lorekit_memory_scopes hides.
   The eight text/tags/int dimension predicates come from lorekit_match_text /
   _tags / _int (00066). The key parameters default to unrestricted, so a
   non-key caller is unaffected and the result stays byte-for-byte 00066''s.';

drop function if exists lorekit_read_activity(uuid, text, timestamptz, timestamptz, text);

create or replace function lorekit_read_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  p_scope   text        default null,
  -- The CALLING KEY's scope allowlist (00067). No org parameters: `usage_events`
  -- is a per-user ledger with no org_id, so there is no tenancy axis to narrow.
  p_key_scopes text[] default '{}'
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
begin
  if p_bucket is null or p_bucket not in ('hour', 'day') then
    raise exception 'invalid bucket %, expected hour or day', p_bucket
      using errcode = '22023';
  end if;

  return query
    select date_trunc(p_bucket, ue.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           ue.scope as scope,
           sum(coalesce(ue.result_count, 0))::bigint as count
      from usage_events ue
     where (
             (v_actor is null and auth.role() = 'service_role')
             or ue.user_id = v_actor
           )
       and ue.tool_name in ('memory.read', 'memory.list', 'memory.search',
                            'memory.list_archived')
       -- The dashboard reading lore in order to DRAW this chart is not a read
       -- the chart should report. `is distinct from` (not `<>`) because the
       -- column is nullable and `null <> 'dashboard'` is null, which would
       -- silently drop every unattributed event — including every row written
       -- before this migration.
       and ue.client is distinct from 'dashboard'
       -- The calling key's scope allowlist (00067). A NULL scope is an
       -- unattributable read: it names nothing, so it leaks nothing, and it is
       -- passed through rather than dropped so the account total a scoped key
       -- sees stays the sum of the rows it is allowed to attribute plus the
       -- ones nobody could. Dropping them would silently erase every event
       -- written before 00058 from a scoped key's chart.
       and (ue.scope is null or lorekit_api_token_scope_allowed(p_key_scopes, ue.scope))
       -- The optional per-scope filter. `=`, not `is not distinct from`: a
       -- caller asking for a named scope wants events attributed to it, never
       -- the unattributable NULL-scope remainder. Omitting the parameter
       -- returns every scope INCLUDING those NULL rows, so the unfiltered
       -- account total stays complete.
       and (p_scope is null or ue.scope = p_scope)
       and (p_since is null or ue.created_at >= p_since)
       and (p_until is null or ue.created_at <  p_until)
     group by 1, ue.scope
    having sum(coalesce(ue.result_count, 0)) > 0
     -- The scope tiebreak is 00051's verbatim (`order by 1 asc, m.scope asc`).
     -- Bucket alone stopped being a total order the moment a bucket could hold
     -- several scopes, and this function's header claims it mirrors that shape,
     -- so intra-bucket row order must be deterministic here too.
     order by 1 asc, ue.scope asc;
end;
$$;

revoke execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[])
  from public, anon;
grant  execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[])
  to authenticated, service_role;

comment on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[]) is
  'Memory RECORDS read per UTC hour/day per scope over the half-open
   [p_since, p_until) window, summed from usage_events.result_count over the
   read tools, excluding dashboard-originated reads. Further narrowed by the
   CALLING KEY''s scope allowlist (00067): this series returns one row per scope
   NAME, so leaving it unnarrowed would leak what lorekit_memory_scopes hides.
   A NULL scope is unattributable, names nothing and is passed through, so the
   account total stays complete. No org parameters — usage_events is a per-user
   ledger with no org axis. The key parameter defaults to unrestricted, so a
   non-key caller sees byte-for-byte 00058''s result.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. memory_delete
--
-- The delete twin of `memory_write`, and the last gate on the other mutation
-- path the transports cannot stand in front of. `DELETE /memories?…&org=` and
-- the MCP `memory.delete` tool both route their org form through this function,
-- which chooses the rows itself — so there is no query left for the edge to
-- filter, and a transport-side check is advisory anyway (service-role client).
--
-- Without the key parameters the org branch enforced `lorekit_org_can` and
-- nothing else: a key whose tenancy is `personal`, or `selected` over a
-- different org, could still hard-delete an org-owned memory as long as its
-- OWNER held the capability. The scope axis is added for the same
-- defence-in-depth reason it was added to `memory_write` — both dispatchers
-- refuse a named scope outside the allowlist, and both are advisory.
--
-- Actor resolution, the capability gates and the personal branch are 00046
-- verbatim; only the two guards and the three defaulted parameters are new.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists memory_delete(uuid, text, text, text, boolean);

create or replace function memory_delete(
  p_user_id  uuid,
  p_org_slug text default null,
  p_scope    text default null,
  p_key      text default null,
  p_force    boolean default false,
  -- The CALLING KEY's restriction (00067), defaulted to unrestricted so every
  -- existing caller — dashboard JWT, the Node path, CI on the service role —
  -- keeps the pre-00068 behaviour with no call-site change.
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (deleted boolean, archived boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_count  integer;
  v_actor  uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  -- The scope allowlist, before either branch. LK002 for the same reason
  -- `memory_write` uses it: `translateDbError` already maps it to a 403, so no
  -- second mapping is needed on either surface.
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug;
    if v_org_id is null then
      raise exception using
        errcode = 'P0001',
        message = format('unknown_org: %s', p_org_slug);
    end if;

    -- The tenancy half. Checked BEFORE the capability gates so a key that may
    -- not reach this org is refused on the key, not on its owner's role — the
    -- two denials are different facts and `key_org_denied` is the true one.
    if not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_org_id) then
      raise exception using errcode = 'LK002',
        message = format('key_org_denied: org=%s', p_org_slug);
    end if;

    if p_force then
      if not lorekit_org_can(v_actor, v_org_id, 'hard_delete') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=hard_delete', p_org_slug);
      end if;

      delete from memories
       where org_id = v_org_id and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      if not lorekit_org_can(v_actor, v_org_id, 'archive') then
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
    -- Personal delete: scoped to the RESOLVED actor, never a named p_user_id.
    if p_force then
      delete from memories
       where user_id = v_actor and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      update memories
         set archived_at = now()
       where user_id = v_actor and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0);
    end if;
  end if;
end;
$$;

-- 00046's revoke is carried over verbatim against the NEW signature: 00020
-- granted `anon` EXPLICITLY, and `revoke … from public` does not remove a
-- per-role grant, so anon must be named again here or a re-created function
-- silently comes back reachable.
revoke execute on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[])
  from public, anon;
grant execute on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[])
  to authenticated, service_role;

comment on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[]) is
  'Archives (p_force=false) or hard-deletes (p_force=true) the effective
   caller''s own memory, or an org''s memory when p_org_slug is given and the
   actor holds the archive / hard_delete capability. Further gated by the
   CALLING KEY''s scope allowlist and tenancy (00067): the org branch chooses
   its rows inside this function, so no transport-side filter can cover it, and
   both dispatchers run on the service-role client and are advisory. The key
   parameters default to unrestricted, so a non-key caller is unaffected.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. lorekit_memory_tags
-- 7. lorekit_memory_facets
--
-- The last two aggregate catalogs on the memories surface. `lorekit_memory_tags`
-- rolls up labels and `lorekit_memory_facets` rolls up every filterable
-- dimension — including `origin_repo`, which is a repository name by
-- construction, so a key restricted to one repo could enumerate every repo on
-- the account through the facet list even with the scope catalog and both
-- activity series narrowed. Narrowing four of six catalogs moves a leak; it does
-- not close one.
--
-- `GET /memories/usage` is deliberately NOT in this list: `lorekit_usage_stats`
-- rolls up by `scope_type`, a bounded low-cardinality value (`repo`, `project`,
-- `global`), never a scope NAME, so there is nothing there to enumerate.
--
-- Both take the two predicates in the row-visibility WHERE, where every value
-- these functions emit is derived from — one place per function, rather than
-- one per emitted facet. Bodies are 00050 / 00066 verbatim otherwise.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists lorekit_memory_tags(uuid, boolean);

create or replace function lorekit_memory_tags(
  p_user_id  uuid,
  p_archived boolean default false,
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (tag text, count bigint)
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
begin
  return query
    select t.tag, count(*) as count
      from memories m
      -- unnest, not a GIN-assisted filter: the catalog is a full rollup of a
      -- text[] column, so every visible row contributes each of its labels.
      cross join lateral unnest(m.tags) as t(tag)
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       -- The calling key's restriction, ANDed on top of the caller's own
       -- visibility and never instead of it (the lorekit_memory_scopes rule).
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
       and (
             case
               when p_archived then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and t.tag is not null
       and btrim(t.tag) <> ''
     group by t.tag
     order by count(*) desc, t.tag asc;
end;
$$;

revoke execute on function lorekit_memory_tags(uuid, boolean, text[], text, uuid[])
  from public, anon;
grant  execute on function lorekit_memory_tags(uuid, boolean, text[], text, uuid[])
  to authenticated, service_role;

comment on function lorekit_memory_tags(uuid, boolean, text[], text, uuid[]) is
  'Label (memories.tags) catalog with per-label counts, for the partition
   selected by p_archived, visible to the EFFECTIVE caller and further narrowed
   by the CALLING KEY''s scope allowlist and tenancy (00067). Same
   service-role-gated actor rule and tenant predicate as lorekit_memory_scopes.
   Ordered count desc, tag asc. The key parameters default to unrestricted, so a
   non-key caller sees byte-for-byte 00050''s result.';

drop function if exists lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
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
  p_owner_mode         text    default 'in',
  -- The CALLING KEY's restriction (00067), defaulted to unrestricted.
  p_key_scopes         text[]  default '{}',
  p_key_org_access     text    default 'all',
  p_key_org_ids        uuid[]  default '{}'
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
      -- Per-dimension match flag, now from the shared predicates so it cannot
      -- drift from lorekit_memory_activity's. A null filter is "not filtered" →
      -- the helper returns true, so an untouched dimension never narrows.
      lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)          as ok_tag,
      lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)  as ok_source_agent,
      lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)       as ok_trigger,
      lorekit_match_text(m.kind,          p_kind,          p_kind_mode)          as ok_kind,
      lorekit_match_text(m.host,          p_host,          p_host_mode)          as ok_host,
      lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)   as ok_origin_repo,
      lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode) as ok_origin_branch,
      lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)     as ok_origin_pr,
      -- Owner: the computed identity is `personal` (org_id null) or the org slug.
      -- Stays inline — it is not one of the three column helpers (00064).
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
       -- The calling key's restriction, applied ONCE here in the row-visibility
       -- predicate every emitted facet value is derived from — `origin_repo` is
       -- a repository name by construction, so an unnarrowed facet list leaks
       -- exactly what the scope catalog hides.
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
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
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr,
   owner) over the partition selected by p_archived, visible to the EFFECTIVE
   caller and further narrowed by the CALLING KEY''s scope allowlist and tenancy
   (00067) — `origin_repo` is a repository name, so an unnarrowed facet list
   would leak what lorekit_memory_scopes hides. `owner` (00064) is `personal`
   for org_id-null rows, else the org slug. Counts are DRILL-DOWN (00057). The
   key parameters default to unrestricted, so a non-key caller sees
   byte-for-byte 00066''s result.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. lorekit_api_token_scope_allowed — the same shape test as the edge
--
-- 00067 treated any pattern ending in `*` as a prefix wildcard. The authority
-- on what a pattern may look like is `SCOPE_PATTERN` in `schemas/api-key.ts`
-- (and `api_tokens_scopes_shape`, which mirrors it): a `*` is a wildcard only
-- directly after `/` or `::`. Under the looser rule a stored `repo::mthines/lore*`
-- became the LIKE prefix `repo::mthines/lore%` and reached every repo starting
-- with those letters — a pattern that WIDENS the key, which is the one direction
-- these predicates must never move.
--
-- Both guards exist because the column can hold a value the CHECK never saw: a
-- BYOD install bootstrapped before 00067, or a constraint dropped by hand. A
-- non-conforming pattern now contributes nothing, exactly as the edge's
-- `keyScopeFilter` drops it — and a key whose patterns ALL fail the shape test
-- matches no row, which is the fail-closed answer for "restricted, with no
-- usable patterns".
--
-- `create or replace` with an unchanged signature, so the 00067 grants stand.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function lorekit_api_token_scope_allowed(
  p_patterns text[],
  p_scope text
)
returns boolean
language sql
immutable
as $$
  select case
    -- Decision 1: an unrestricted key is the default and the common case, so it
    -- is the first branch and costs no array walk.
    when p_patterns is null or cardinality(p_patterns) = 0 then true
    -- A scopeless operation (memory.purge_expired, the account-wide reads)
    -- cannot be matched against an allowlist. Refusing it is the fail-closed
    -- answer: a key narrowed to one repo has no business sweeping the account.
    when p_scope is null then false
    else exists (
      select 1
      from unnest(p_patterns) as pattern
      -- SCOPE_PATTERN's shape, verbatim. A pattern that fails it is dropped
      -- rather than matched literally, so it can only ever narrow.
      where pattern ~ '^[a-z0-9._:/-]+((/|::)\*)?$'
        and case
          when right(pattern, 1) = '*'
            -- Escape LIKE's single-character wildcard in the literal prefix so
            -- `repo::my_org/*` stays owner-exact instead of also matching
            -- `repo::myXorg/...`. `%` and `\` cannot occur — the CHECK's charset
            -- excludes them. Same reasoning, same escape, as expandScopeForSearch.
            then p_scope like replace(left(pattern, -1), '_', '\_') || '%'
          else p_scope = pattern
        end
    )
  end;
$$;

comment on function lorekit_api_token_scope_allowed(text[], text) is
  'May a key whose api_tokens.scopes is p_patterns touch p_scope? Empty '
  'allowlist = yes (unrestricted). NULL scope = no (fail closed). A pattern '
  'outside SCOPE_PATTERN''s shape is DROPPED, not matched, so a stored '
  'mid-token wildcard cannot widen the key (00068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. lorekit_memory_list
--
-- 00067 (merged to main while this branch was open) moved the list read out of
-- PostgREST and into a SQL function, so a wide filter never becomes a URL. That
-- relocated the ENTIRE list read behind a predicate this migration's transports
-- cannot reach: `applyRestTenantScope` no longer runs on that path, and the
-- function's own visibility predicate knows nothing about a key restriction.
-- Left alone, `GET /memories` and `POST /memories/list` would be the one
-- family a scoped key still reads unnarrowed — the widest possible hole, in the
-- most-used endpoint.
--
-- Carried over verbatim from 00067 apart from the three parameters and the two
-- predicate calls they feed. DROP-then-create for the usual reason: a defaulted
-- parameter is an overload, not a replacement.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer
);

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
  p_limit                integer     default 51,
  -- The CALLING KEY's restriction (00068). Defaulted, so every existing caller
  -- — a dashboard JWT, CI on the service role — keeps the pre-00069 behaviour.
  p_key_scopes           text[]      default '{}',
  p_key_org_access       text        default 'all',
  p_key_org_ids          uuid[]      default '{}'
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
  -- break the page.
  --
  -- The digit count is BOUNDED, which a bare `^[0-9]+$` is not: `99999999999`
  -- is all digits and still overflows int4, so `x::integer` would raise 22003
  -- and turn a hand-editable filter value into a 500 — the exact opposite of
  -- the drop this comment promises. Nine significant digits is the widest run
  -- that cannot overflow, and the leading `0*` keeps the zero-padded form
  -- working (`007` → 7, as GET /memories has always resolved it). The guard is
  -- a regex rather than a `x::numeric <= 2147483647` conjunct because WHERE
  -- conjuncts have no guaranteed evaluation order, so a cast there could still
  -- see a non-numeric value and raise 22P02.
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^0*[0-9]{1,9}$'
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
       -- The calling key's own restriction, ANDed onto the caller's visibility
       -- and never instead of it: a key can only NARROW what its owner already
       -- sees, so the account boundary above is untouched. This is the same
       -- pair every other key-aware reader applies; it is here because 00067
       -- moved the list read into this function, and a reader the enforcement
       -- does not reach is a reader that leaks.
       and lorekit_api_token_scope_allowed($32, m.scope)
       and lorekit_api_token_org_allowed($33, $34, m.org_id)
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
    greatest(coalesce(p_limit, 51), 1),
    coalesce(p_key_scopes, '{}'::text[]),
    coalesce(p_key_org_access, 'all'),
    coalesce(p_key_org_ids, '{}'::uuid[]);
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[]
) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[]
) to authenticated, service_role;

comment on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[]
) is
  'One keyset page of the memories visible to the EFFECTIVE caller, further
   narrowed by the CALLING KEY''s scope allowlist and tenancy (00068). Otherwise
   identical to the function 00067 introduced; the key parameters default to
   unrestricted, so a non-key caller is unaffected.';
