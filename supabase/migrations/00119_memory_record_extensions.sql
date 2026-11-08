-- 00119 — four additive fields on the memory record.
--
-- Closes the additive gaps from the blog post "Seven gaps in LoreKit's memory
-- format", without changing any existing write or read:
--
--   attributes    jsonb  an open map of namespaced keys (`ci.run_url`, `vcs.pr`)
--                        to scalar values. MERGED on update, like origin's
--                        keep-last-known: a write names only the keys it
--                        changes, and a key written as null is removed.
--   content_type  text   `text/markdown` (default) or `application/json`. A
--                        JSON body must parse (CHECK, so every write path and
--                        every later update is held to it, not only the RPC).
--   supersedes    uuid   the id of the memory this one replaces. Kept on
--                        update unless re-supplied; cleared if the target is
--                        hard-deleted. Only an id the caller can read AND
--                        that has the same owner (personal, or the same org)
--                        is accepted, by the RPC and by a direct write.
--   cited ids            `lorekit_record_memory_citations` also resolves a
--                        lesson named by its id, not only by scope/key.
--
-- `memory_write` and `lorekit_record_memory_citations` change signature, so
-- the old overloads are DROPPED and recreated (a CREATE OR REPLACE with new
-- parameters would add a second overload and make named-argument calls
-- ambiguous). The `memory_write` body is 00116's, verbatim except the marked
-- 00119 block and the three new columns in each branch. Field validation for
-- the edge lives in the shared `record-extensions.ts` parser; these
-- constraints are the last gate.

-- 1. Columns ──────────────────────────────────────────────────────────────────

create or replace function lorekit_is_json(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  perform p_value::jsonb;
  return true;
exception
  when others then
    return false;
end;
$$;

comment on function lorekit_is_json(text) is
  'True when p_value parses as JSON. Backs the memories_json_value_parses CHECK.';

alter table memories
  add column if not exists attributes   jsonb not null default '{}'::jsonb,
  add column if not exists content_type text  not null default 'text/markdown',
  add column if not exists supersedes   uuid  references memories(id) on delete set null;

alter table memories drop constraint if exists memories_attributes_is_object;
alter table memories add constraint memories_attributes_is_object
  check (jsonb_typeof(attributes) = 'object');

alter table memories drop constraint if exists memories_content_type_known;
alter table memories add constraint memories_content_type_known
  check (content_type in ('text/markdown', 'application/json'));

alter table memories drop constraint if exists memories_json_value_parses;
alter table memories add constraint memories_json_value_parses
  check (content_type <> 'application/json' or lorekit_is_json(value));

alter table memories drop constraint if exists memories_supersedes_not_self;
alter table memories add constraint memories_supersedes_not_self
  check (supersedes is null or supersedes <> id);

create or replace function lorekit_jsonb_key_count(p_value jsonb)
returns integer
language sql
immutable
set search_path = public
as $$
  select count(*)::integer from jsonb_object_keys(p_value);
$$;

-- The 32-key cap holds for the STORED map, not only per write: updates merge,
-- so a series of writes that each name new keys would otherwise grow it
-- without bound.
alter table memories drop constraint if exists memories_attributes_max_keys;
alter table memories add constraint memories_attributes_max_keys
  check (lorekit_jsonb_key_count(attributes) <= 32);

create index if not exists memories_supersedes_idx
  on memories (supersedes) where supersedes is not null;

comment on column memories.attributes is
  'Open map of namespaced keys (ci.run_url, vcs.pr) to scalar values. Merged on update; a null value removes the key.';
comment on column memories.content_type is
  'What the value is: text/markdown (default) or application/json (must parse).';
comment on column memories.supersedes is
  'The id of the memory this one replaces. NULL when it replaces nothing, or when the target was hard-deleted.';

-- The same `supersedes` rule for a write that does not go through
-- `memory_write`: a signed-in client may insert or update `memories` directly
-- through PostgREST (RLS allows its own rows), and a foreign-key check ignores
-- RLS — so without this, a 23503-vs-200 answer would reveal whether any
-- tenant's id exists. The function is SECURITY INVOKER, so its lookup sees
-- only what RLS lets the caller see, and it fails a hidden target exactly like
-- a missing one. It runs BEFORE the deferred foreign-key check. A
-- SECURITY DEFINER caller (`memory_write`, which checks for itself) and the
-- service role skip it.
create or replace function lorekit_memories_check_supersedes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.supersedes is null
     or (tg_op = 'UPDATE'
         and new.supersedes is not distinct from old.supersedes
         and new.org_id is not distinct from old.org_id
         and new.user_id is not distinct from old.user_id)
     or current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if not exists (
    select 1
      from memories m
     where m.id = new.supersedes
       and m.org_id is not distinct from new.org_id
       and (new.org_id is not null or m.user_id = new.user_id)
  ) then
    raise exception using errcode = 'P0001',
      message = format('supersedes_not_found: %s', new.supersedes);
  end if;
  return new;
end;
$$;

drop trigger if exists memories_check_supersedes on memories;
create trigger memories_check_supersedes
  before insert or update of supersedes, org_id, user_id on memories
  for each row execute function lorekit_memories_check_supersedes();

-- `on delete set null` clears `supersedes` on every row that linked to a
-- hard-deleted memory. That is housekeeping, not an edit, so it must not bump
-- `updated_at` (age-based retention reads it). 00107's trigger, verbatim except
-- the marked 00119 lines: a cleared link joins the derived-column exemption.
create or replace function lorekit_memories_set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_new memories := new;
  v_old memories := old;
  v_embedding_changed boolean;
  v_counters_changed  boolean;
  v_link_cleared      boolean;  -- 00119
begin
  v_embedding_changed :=
       new.embedding is distinct from old.embedding
    or new.embedding_model is distinct from old.embedding_model;

  v_counters_changed :=
       new.read_count     is distinct from old.read_count
    or new.last_read_at   is distinct from old.last_read_at
    or new.last_opened_at is distinct from old.last_opened_at
    or new.opened_count   is distinct from old.opened_count
    or new.cited_count    is distinct from old.cited_count
    or new.last_cited_at  is distinct from old.last_cited_at;

  -- 00119: only a CLEAR is exempt. Setting or changing a link is an edit.
  v_link_cleared := old.supersedes is not null and new.supersedes is null;

  -- `fts` must be masked: see 00107.
  v_new.embedding := null; v_new.embedding_model := null;
  v_new.read_count := null; v_new.last_read_at := null; v_new.last_opened_at := null;
  v_new.opened_count := null;
  v_new.cited_count := null; v_new.last_cited_at := null;
  v_new.updated_at := null; v_new.fts := null;
  v_new.supersedes := null;  -- 00119

  v_old.embedding := null; v_old.embedding_model := null;
  v_old.read_count := null; v_old.last_read_at := null; v_old.last_opened_at := null;
  v_old.opened_count := null;
  v_old.cited_count := null; v_old.last_cited_at := null;
  v_old.updated_at := null; v_old.fts := null;
  v_old.supersedes := null;  -- 00119

  if (v_embedding_changed or v_counters_changed or v_link_cleared)
     and v_new is not distinct from v_old then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;

  return new;
end;
$$;

-- 2. memory_write ─────────────────────────────────────────────────────────────

drop function if exists memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text, text[], text, uuid[]
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
  p_attributes    jsonb       default null,
  p_content_type  text        default null,
  p_supersedes    uuid        default null,
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
  expires_at       timestamptz,
  scope            text,
  key              text,
  value            text,
  tags             text[],
  source_agent     text,
  trigger          text,
  updated_at       timestamptz,
  archived_at      timestamptz,
  origin_repo      text,
  origin_branch    text,
  origin_commit    text,
  origin_pr        integer,
  kind             text,
  host             text,
  seen_count       integer,
  attributes       jsonb,
  content_type     text,
  supersedes       uuid
)
language plpgsql
security definer
set search_path = public
as $$
-- See 00075's comment for why this directive is required (the OUT columns
-- `scope`/`key` collide with the bare column names in the `on conflict`
-- arbiter lists below).
#variable_conflict use_column
declare
  v_org_id       uuid;
  v_binding_org  uuid;
  v_binding_slug text;
  v_expires_at   timestamptz;
  v_ttl_action   text := 'keep';
begin
  -- The actor is the verified caller, never a request field (the rule 00046
  -- applied to archive/restore/purge). This function is SECURITY DEFINER and
  -- granted to anon/authenticated, so without this a PostgREST caller names
  -- any p_user_id. A caller-supplied id is honoured only on a verified
  -- service-role connection (the edge/MCP api_key path resolves the token
  -- owner and passes it) or a direct connection with no JWT role at all; an
  -- anon or authenticated caller acts as `auth.uid()`, and no identity is refused.
  if auth.role() is distinct from 'service_role' and auth.role() is not null then
    if auth.uid() is null then
      raise exception using errcode = 'LK002', message = 'not_authenticated';
    end if;
    p_user_id := auth.uid();
  end if;

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
    if not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_org_id) then
      raise exception using errcode = 'LK002',
        message = format('key_org_denied: org=%s', p_org_slug);
    end if;
  else
    -- Wildcard-aware, most-specific-wins resolution. A binding matches
    -- p_scope either by exact string equality, or — when it ends in '*' — as
    -- an owner-wildcard prefix (the same LIKE-escaping `lorekit_api_token_
    -- scope_allowed` (00068) uses, since `%` and `\` cannot occur in a
    -- pattern that already passed the grammar gate above). Among matches:
    -- exact (is-wildcard = false) always sorts before any wildcard; among
    -- wildcards, the LONGER literal prefix (length desc) sorts first as the
    -- more specific match; the trailing `scope asc` is a determinism
    -- safeguard for a tie that provably cannot occur (see the header
    -- comment), not a reachable precedence branch.
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where o.deleted_at is null
      and (
        b.scope = p_scope
        or (
          right(b.scope, 1) = '*'
          and p_scope like replace(left(b.scope, -1), '_', '\_') || '%'
        )
      )
    order by (right(b.scope, 1) = '*') asc, length(b.scope) desc, b.scope asc
    limit 1;

    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write')
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_binding_org) then
      v_org_id := v_binding_org;
    end if;
  end if;

  -- 00116: a PERSONAL write is gated by the key's tenancy too. Every branch
  -- above either picked an org (and checked it) or left v_org_id NULL, which
  -- means "write a personal row" — the one destination no tenancy used to gate,
  -- because every tenancy could reach personal rows. `orgs_only` cannot, so
  -- refuse instead of silently falling back to personal: a token that was
  -- scoped to publish org lore must never grow its owner a personal row.
  if v_org_id is null
     and not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, null) then
    raise exception using errcode = 'LK002',
      message = format('key_personal_denied: this token may not write personal memories (scope=%s)', p_scope);
  end if;

  -- 00119: a `supersedes` link may only name a memory with the SAME OWNER
  -- as the row being written — the caller's own personal memory for a personal
  -- write, a memory of the same org for an org write — inside this key's scope
  -- allowlist. Same-owner rather than "any memory the caller can read" so an
  -- org row never exposes the id of its writer's personal memory to every
  -- other member. An unreachable id fails EXACTLY like a nonexistent one, so
  -- the link cannot be used to probe for other tenants' memory ids. The
  -- service-role tier (p_user_id null) may link to any existing memory.
  if p_supersedes is not null and not exists (
    select 1
      from memories m
     where m.id = p_supersedes
       and (
         p_user_id is null
         or (
           lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
           and case
                 when v_org_id is not null then m.org_id = v_org_id
                 else m.org_id is null and m.user_id = p_user_id
               end
         )
       )
  ) then
    raise exception using errcode = 'P0001',
      message = format('supersedes_not_found: %s', p_supersedes);
  end if;

  if v_org_id is not null then
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes;

  elsif p_user_id is null then
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes;

  else
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes;
  end if;
end;
$$;


grant execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[]
) to anon, authenticated, service_role;

-- 3. lorekit_record_memory_citations ─────────────────────────────────────────

drop function if exists lorekit_record_memory_citations(uuid, uuid, text[], text[], text);

create or replace function lorekit_record_memory_citations(
  p_user_id          uuid,
  p_citing_memory_id uuid,
  p_cited_scopes     text[],
  p_cited_keys       text[],
  p_correlation_id   text default null,
  p_cited_ids        uuid[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  -- The actor is the verified caller, never a request field: see memory_write.
  if auth.role() is distinct from 'service_role' and auth.role() is not null then
    if auth.uid() is null then
      raise exception using errcode = 'LK002', message = 'not_authenticated';
    end if;
    p_user_id := auth.uid();
  end if;

  -- 00119: a citation may also name a lesson by its id (p_cited_ids). The
  -- scope/key pair arrays stay paired; either list may be empty.
  if p_user_id is null
     or coalesce(array_length(p_cited_scopes, 1), 0) <> coalesce(array_length(p_cited_keys, 1), 0)
     or (coalesce(array_length(p_cited_scopes, 1), 0) = 0
         and coalesce(array_length(p_cited_ids, 1), 0) = 0)
  then
    return 0;
  end if;

  -- Resolve refs → ids under the CALLER'S OWN tenancy, and nothing wider. This
  -- runs SECURITY DEFINER on a service-role connection where `auth.uid()` is
  -- NULL for the api_key tier, so the `user_id` predicate is the only thing
  -- standing between a citation and someone else's lore. A ref that resolves to
  -- nothing is silently skipped: it names a lesson this account cannot see, or
  -- one that has since been deleted, and neither is the write's problem.
  --
  -- Org-owned lore is deliberately NOT resolvable here yet. `memories.user_id`
  -- is the row's owner, and widening to `lorekit_member_org_ids` would let one
  -- member's retrospective move a counter on a shared lesson that other members
  -- read — a decision about shared state that belongs in its own change, with
  -- its own audit story. Under-counting again, deliberately.
  with refs as (
    select trim(s.scope) as scope, trim(k.key) as key
      from unnest(p_cited_scopes) with ordinality as s(scope, n)
      join unnest(p_cited_keys)   with ordinality as k(key, n) using (n)
     where trim(s.scope) <> '' and trim(k.key) <> ''
  ),
  resolved as (
    select distinct m.id
      from refs r
      join memories m
        on (m.scope = r.scope and m.key = r.key)
       and m.user_id = p_user_id
       and m.archived_at is null
     -- A lesson cannot cite itself. A retrospective that names its own key is
     -- a model echoing the write it is making, not evidence of anything.
     where p_citing_memory_id is null or m.id <> p_citing_memory_id
    union
    -- 00119: the same tenancy, liveness and self-citation rules, for a lesson
    -- named by id.
    select m.id
      from memories m
     where m.id = any(coalesce(p_cited_ids, '{}'))
       and m.user_id = p_user_id
       and m.archived_at is null
       and (p_citing_memory_id is null or m.id <> p_citing_memory_id)
  ),
  ins as (
    insert into memory_citations (user_id, cited_memory_id, citing_memory_id, correlation_id)
    select p_user_id, resolved.id, p_citing_memory_id, p_correlation_id
      from resolved
    on conflict do nothing
    returning cited_memory_id
  ),
  bumped as (
    -- Only the rows that ACTUALLY inserted move a counter, which is what makes
    -- the counter and the ledger agree after a retry.
    select cited_memory_id, count(*)::integer as n from ins group by cited_memory_id
  ),
  upd as (
    update memories m
       set cited_count = m.cited_count + b.n,
           last_cited_at = now()
      from bumped b
     where m.id = b.cited_memory_id
    returning b.n
  )
  select coalesce(sum(n), 0)::integer into v_inserted from upd;

  return v_inserted;
exception
  when others then
    -- Never let a citation break the write it accompanies. Same posture as
    -- `lorekit_record_memory_reads` and `lorekit_record_usage_event`.
    return 0;
end;
$$;

comment on function lorekit_record_memory_citations(uuid, uuid, text[], text[], text, uuid[]) is
  'Records that the write identified by p_citing_memory_id credited each
   (p_cited_scopes[i], p_cited_keys[i]) lesson, and each lesson whose id is in
   p_cited_ids, for shaping the run p_correlation_id groups, and bumps
   memories.cited_count/.last_cited_at for each citation that was actually new.
   Resolves references ONLY within p_user_id''s own active lore -- an
   unresolvable ref is skipped, and a self-citation is dropped. Returns how many
   citations were newly recorded (0 on a duplicate run, 0 on any error).
   Swallows its own errors: a citation must never break the write carrying it.';

grant execute on function lorekit_record_memory_citations(uuid, uuid, text[], text[], text, uuid[])
  to authenticated, service_role;
