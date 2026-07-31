-- ═════════════════════════════════════════════════════════════════════════
-- Memory origin (provenance): where a lesson was RECORDED FROM.
--
-- A memory's `scope` says WHERE the lesson applies. It does not say where the
-- lesson came from: a `global` lesson can be learned while reviewing a pull
-- request, and a `repo::`-scoped lesson says nothing about which branch,
-- commit, or PR taught it. The dashboard could therefore only ever render a
-- "Repo" row by string-splitting the scope — and never a branch, commit, or
-- pull-request link.
--
-- Four nullable, independently-optional columns close that gap:
--   origin_repo    owner/name of the repository the write happened in
--   origin_branch  the git branch the write happened on
--   origin_commit  the commit SHA that was checked out
--   origin_pr      the pull request number the work belonged to
--
-- Design notes:
--   * Separate typed columns, not a JSONB blob — each one is independently
--     queryable and CHECK-constrainable, and the shapes are known and stable.
--   * `origin_branch` is NOT lowercased (unlike a `branch::` scope, which is
--     canonically lowercased and therefore produces `/tree/` links that 404 on
--     a mixed-case branch). Stored verbatim so its GitHub link resolves.
--   * On UPSERT each field uses `coalesce(excluded.x, memories.x)`: the newest
--     write wins when it knows the value, and a write that does NOT know it
--     (an agent with no git context) never erases what a previous write did
--     know. "Last known origin", never a regression to unknown.
--   * The application layer validates and normalises all four before they get
--     here (packages/mcp-core/src/origin.ts, mirrored self-contained into
--     supabase/functions/_shared/origin.ts). The CHECK constraints below are
--     the backstop, deliberately looser than the app-layer regexes so a future
--     provider with a slightly different ref shape does not require a
--     migration to accept.
--   * No index: no read path filters on these columns today (they are rendered
--     from a row already fetched by `(scope, key)` or by the keyset list). Add
--     one with the feature that first filters on origin, not speculatively.
--
-- The RPC widening follows the established pattern (00009, 00030, 00031,
-- 00038): DROP the old overload FIRST — `create or replace` alone would leave
-- a stale N-arg overload and PostgREST, which resolves RPCs by ARGUMENT NAME,
-- would see an ambiguous call — then recreate with the new params appended
-- LAST and DEFAULTed, then re-issue the GRANTs against the new signature.
-- Forward-only.
-- ═════════════════════════════════════════════════════════════════════════

alter table memories add column if not exists origin_repo   text;
alter table memories add column if not exists origin_branch text;
alter table memories add column if not exists origin_commit text;
alter table memories add column if not exists origin_pr     integer;

alter table memories drop constraint if exists memories_origin_repo_check;
alter table memories add  constraint memories_origin_repo_check
  check (origin_repo is null or (length(origin_repo) between 3 and 140 and origin_repo like '%/%'));

alter table memories drop constraint if exists memories_origin_branch_check;
alter table memories add  constraint memories_origin_branch_check
  check (origin_branch is null or length(origin_branch) between 1 and 255);

alter table memories drop constraint if exists memories_origin_commit_check;
alter table memories add  constraint memories_origin_commit_check
  check (origin_commit is null or origin_commit ~ '^[0-9a-f]{7,40}$');

alter table memories drop constraint if exists memories_origin_pr_check;
alter table memories add  constraint memories_origin_pr_check
  check (origin_pr is null or origin_pr >= 1);

comment on column memories.origin_repo   is 'Provenance: owner/name of the repository this memory was last recorded from.';
comment on column memories.origin_branch is 'Provenance: git branch this memory was last recorded from (verbatim case).';
comment on column memories.origin_commit is 'Provenance: commit SHA checked out when this memory was last recorded.';
comment on column memories.origin_pr     is 'Provenance: pull request number this memory was last recorded from.';

drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean);

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
  p_origin_pr     integer     default null
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
  -- Tri-state for the expires_at UPDATE branch:
  --   'clear'  → set to NULL
  --   'set'    → set to v_expires_at
  --   'keep'   → leave unchanged (CASE WHEN ... ELSE memories.expires_at END)
  v_ttl_action   text := 'keep';
begin
  if p_clear_ttl then
    -- Explicit clear wins over any p_ttl_seconds value.
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
  else
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where b.scope = p_scope and o.deleted_at is null;

    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write') then
      v_org_id := v_binding_org;
    end if;
  end if;

  if v_org_id is not null then
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      -- Last KNOWN origin wins: a write that does not know a field leaves the
      -- previously recorded one intact rather than erasing it.
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
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
      origin_repo, origin_branch, origin_commit, origin_pr
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr
    )
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
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
      origin_repo, origin_branch, origin_commit, origin_pr
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr
    )
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
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

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean, text, text, text, integer)
  to anon, authenticated, service_role;
