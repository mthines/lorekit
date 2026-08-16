-- ═════════════════════════════════════════════════════════════════════════
-- API token scoping, part 2 of 2: the SQL-side enforcement.
--
-- 00067 added the data model (`api_tokens.scopes` / `org_access` / `org_ids`)
-- and the two predicates, and enforced nothing. This migration teaches the two
-- functions that the transports CANNOT stand in front of:
--
--   1. `memory_write` — the last unbypassable gate on the write path. The edge
--      holds the service-role key, so every check above this function is
--      advisory by construction; and the scope→org BINDING lives in here, where
--      no transport can see it. 00067 decision 4 says the key restriction beats
--      the binding, and this is the only place that sentence can be true.
--
--   2. `lorekit_memory_scopes` — the scope catalog. Filtering reads without
--      filtering this one would leave scoping leaking exactly what it hides: a
--      scope string IS a repo or project name, so a key narrowed to one repo
--      could still enumerate every repo on the account.
--
-- Both take the calling key's restriction as DEFAULTED trailing parameters, so
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
-- ── Why both functions are DROPped first ──────────────────────────────────
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
  -- The CALLING KEYs tenancy, defaulted so every existing caller (JWT, the
  -- Node path, CI service-role) keeps the pre-00068 behaviour untouched.
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
  integer, boolean, text, text, text, integer, text, text, text, uuid[]
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
