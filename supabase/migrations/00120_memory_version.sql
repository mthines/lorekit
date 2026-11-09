-- 00120 — a version number on every memory, and optimistic concurrency on write.
--
-- THE GAP. A memory gets corrected (a January runbook fixed in March) and a
-- reader cannot tell: a write to the same scope+key overwrites in place and only
-- `updated_at` moves — and `updated_at` also moves for edits that change nothing
-- a reader would read (a TTL, a re-sighting). Two agents correcting the same
-- lesson also race: the second write silently replaces the first.
--
--   version            integer, starts at 1, +1 on every CONTENT change.
--                      Content is what a reader reads: `value`, `content_type`,
--                      `attributes`, `tags`, and a `supersedes` link being set
--                      or changed. A TTL change, a read/open/cite counter, an
--                      embedding, archive/restore, an owner move, a re-write of
--                      identical content, and a link CLEARED because its target
--                      was hard-deleted (00119) are not edits and do not bump it.
--   p_expected_version on memory_write: the version the caller last read. A
--                      mismatch is refused with LK003 `version_conflict` and
--                      nothing is written; 0 means "the key must not exist".
--
-- WHY A TRIGGER. Every write path obeys the rule — memory_write's upsert, a
-- REST PATCH (a plain column update), a direct PostgREST update, a groom — so it
-- lives on the table, not in one RPC. The same trigger is why a caller can never
-- set `version` itself: an INSERT always starts at 1 and an UPDATE always gets
-- the derived value, whatever the statement said.
--
-- TRIGGER ORDER. Postgres fires same-timing row triggers in NAME order, so
-- `memories_bump_version` runs before `memories_updated_at` (00103). That order
-- is what lets the updated_at trigger compare whole rows unchanged: by the time
-- it runs, `version` differs from the old row only when content did.
--
-- `memory_write` changes signature (a new parameter and a new returned column),
-- so 00119's overload is DROPPED and recreated — the body is 00119's verbatim
-- except the lines marked 00120. `lorekit_memory_list` (00115) returns `version`
-- too, which changes its return type, so it is likewise dropped and recreated
-- verbatim except the marked lines; its arguments, grants and comment are 00115's.
--
-- The column is a constant default on a NOT NULL column: since Postgres 11 that
-- is a catalog-only change, so existing rows read back as 1 without a rewrite
-- or a backfill UPDATE (REVIEW.md invariants 1 and 2). The brief ACCESS
-- EXCLUSIVE lock it still takes runs under a lock_timeout.

-- 1. Column ───────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

alter table memories
  add column if not exists version integer not null default 1;

alter table memories drop constraint if exists memories_version_positive;
alter table memories add constraint memories_version_positive
  check (version >= 1);

reset lock_timeout;

comment on column memories.version is
  'Starts at 1 and increases by 1 on every content change (value, content_type, attributes, tags, or a supersedes link set or changed). Maintained by the memories_bump_version trigger; a caller cannot set it.';

-- 2. The bump trigger ─────────────────────────────────────────────────────────

create or replace function lorekit_memories_bump_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    return new;
  end if;

  if new.value        is distinct from old.value
     or new.content_type is distinct from old.content_type
     or new.attributes   is distinct from old.attributes
     or new.tags         is distinct from old.tags
     -- Setting or changing a link is an edit; clearing one is not (00119: a
     -- link is cleared by `on delete set null` when its target is hard-deleted).
     or (new.supersedes is not null and new.supersedes is distinct from old.supersedes)
  then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function lorekit_memories_bump_version() is
  'BEFORE INSERT OR UPDATE on memories: an insert starts at version 1; an update gets old.version + 1 when value, content_type, attributes, tags or a non-null supersedes changed, and old.version otherwise. Overrides any version the statement set.';

revoke execute on function lorekit_memories_bump_version() from public, anon;

drop trigger if exists memories_bump_version on memories;
create trigger memories_bump_version
  before insert or update on memories
  for each row execute function lorekit_memories_bump_version();

-- 3. memory_write ─────────────────────────────────────────────────────────────

drop function if exists memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[]
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
  p_key_org_ids    uuid[]     default '{}',
  p_expected_version integer  default null  -- 00120
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
  supersedes       uuid,
  version          integer  -- 00120
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
  v_current_version integer;  -- 00120
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

  -- 00120: optimistic concurrency. `p_expected_version` is the version the
  -- caller last read; 0 means "this key must not exist yet". The live row this
  -- write would upsert (the same owner + scope + key the conflict target below
  -- names) is locked FOR UPDATE, so nothing can move its version between this
  -- check and the upsert. A key with no live row is version 0. The `where` on
  -- every `do update` below re-states the check, which is what closes the one
  -- race the lock cannot: two writers that both expected 0 and both found no
  -- row. The second one's insert lands on the first one's row, the `where` is
  -- false, nothing is written, and it gets the same conflict.
  --
  -- EXPIRED counts as absent. Every read hides a row whose `expires_at` has
  -- passed, so a caller that read the key saw nothing: its version is 0 here
  -- and in the `where` guards, the same liveness the reads use. The expired
  -- row is still the conflict target (the unique indexes are partial on
  -- `archived_at` only), so the write UPDATES it in place, and its version
  -- CONTINUES counting from the expired row's (+1 on a content change) rather
  -- than restarting at 1: the row keeps its id, created_at and seen_count, so
  -- it is the same record coming back, and restarting would need the bump
  -- trigger to second-guess liveness on every update. A caller therefore
  -- expects 0 and may read back a version above 1.
  if p_expected_version is not null then
    if p_expected_version < 0 then
      raise exception using errcode = '22023',
        message = format('expected_version must be >= 0, got %s', p_expected_version);
    end if;
    select case when m.expires_at is not null and m.expires_at <= now() then 0
                else m.version end
      into v_current_version
      from memories m
     where m.scope = p_scope
       and m.key = p_key
       and m.archived_at is null
       and case
             when v_org_id is not null then m.org_id = v_org_id
             when p_user_id is null then m.org_id is null and m.user_id is null
             else m.org_id is null and m.user_id = p_user_id
           end
       for update;
    v_current_version := coalesce(v_current_version, 0);
    if v_current_version <> p_expected_version then
      raise exception using errcode = 'LK003',
        message = format('version_conflict: expected_version=%s current_version=%s',
                         p_expected_version, v_current_version);
    end if;
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
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120

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
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120

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
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120
  end if;

  -- 00120: the `do update ... where` above declined the write (a concurrent
  -- writer moved the version after the gate, or created the row a 0 expected
  -- to be absent). Nothing was written; report the version that won.
  if p_expected_version is not null and not found then
    select case when m.expires_at is not null and m.expires_at <= now() then 0
                else m.version end
      into v_current_version
      from memories m
     where m.scope = p_scope
       and m.key = p_key
       and m.archived_at is null
       and case
             when v_org_id is not null then m.org_id = v_org_id
             when p_user_id is null then m.org_id is null and m.user_id is null
             else m.org_id is null and m.user_id = p_user_id
           end;
    raise exception using errcode = 'LK003',
      message = format('version_conflict: expected_version=%s current_version=%s',
                       p_expected_version, coalesce(v_current_version, 0));
  end if;
end;
$$;


revoke execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[], integer
) from public;
-- anon keeps 00119's grant: the body refuses it with LK002 not_authenticated.
grant execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[], integer
) to anon, authenticated, service_role;

-- 4. lorekit_memory_list ─────────────────────────────────────────────────────

drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]);

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
  total_count    integer,
  version        integer  -- 00120
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
      (count(*) over ())::integer as total_count,
      m.version  -- 00120
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
