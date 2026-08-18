-- ═════════════════════════════════════════════════════════════════════════
-- API token scoping: restrict a key to specific scopes and/or specific orgs.
--
-- Until now a key inherited the ENTIRE visibility of its owning user — every
-- personal memory plus every org they belong to (`applyTenantScope`). The only
-- capability axis was read/write (`permissions text[]`, 00002). That makes a
-- token handed to one repo's CI a credential for the whole account, which is
-- the thing this migration fixes: a key can now be narrowed to a set of scope
-- patterns and to a tenancy (personal only / all orgs / named orgs), on top of
-- the read/write axis it already had.
--
-- ── Decisions, and why ────────────────────────────────────────────────────
--
-- 1. EMPTY MEANS UNRESTRICTED. `scopes = '{}'` is "every scope the owner can
--    see", not "no scope at all". The alternative (empty = deny) reads safer
--    but silently bricks every existing key on deploy AND the key the dashboard
--    auto-generates on first login (`onboarding-steps.tsx`), which has no UI to
--    pick scopes from. Restriction is therefore opt-in and additive, and the
--    column's default reproduces today's behaviour exactly. `permissions` (a
--    text[] with NO check and an unrepresentable empty set) is the cautionary
--    tale next door — hence the explicit CHECKs below.
--
-- 2. ORG ACCESS IS A TRI-STATE, NOT A LIST. A bare `org_ids uuid[]` cannot say
--    "personal only": an empty list would have to mean both "unrestricted" and
--    "no orgs", and those are the two most different answers in the space. So
--    tenancy is an enum (`all` | `personal` | `selected`) with the list only
--    meaningful — and only permitted — under `selected`.
--
-- 3. SCOPE PATTERNS REUSE THE EXISTING WILDCARD GRAMMAR. `repo::mthines/*` is
--    already a thing users type (`expandScopeForSearch`), so a key allowlist
--    accepts the same shape rather than inventing a second matcher. The CHECK's
--    charset is deliberately byte-identical to that function's PostgREST
--    injection guard (`[a-z0-9._:/-]`) — the values end up in the same kind of
--    predicate, so they get the same gate — and so is its WILDCARD POSITION: a
--    trailing `*` counts only after `/` or `::`, exactly as that function
--    requires. An "any trailing star" rule would have let `repo::mthines/lore*`
--    allowlist `repo::mthines/lorekit-private` while being REFUSED as a search
--    filter — two different grammars wearing one syntax.
--
-- 4. THE KEY WINS OVER A SCOPE→ORG BINDING. `org_scope_bindings` (00026)
--    auto-routes a write under a bound scope into that org. A key restricted to
--    `personal` writing under a bound scope must NOT land in an org the key was
--    never granted — the binding is a convenience, the key restriction is an
--    authorization boundary, and a boundary that a convenience can widen is not
--    one. `lorekit_api_token_org_allowed` is the predicate that says so; wiring
--    it into `memory_write`'s routing is the next migration's job, together
--    with the transport-side enforcement.
--
-- 5. WRITES GO THROUGH AN RPC, NOT AN UPDATE POLICY. 00002 deliberately has no
--    UPDATE policy on `api_tokens`. Adding one now would put an authorization
--    decision (may this actor point this key at this org?) in a WITH CHECK
--    expression, which cannot consult `org_members` without re-deriving the
--    tenancy predicate a second time. `lorekit_api_token_set_scoping` is the
--    Phase-3 shape instead: SECURITY DEFINER, actor from `auth.uid()`, never a
--    caller-supplied user id.
--
-- Nothing here ENFORCES anything yet — this migration is the data model plus
-- the two predicates. The transports (`mcp/auth.ts`, `_shared/api/auth.ts`,
-- `mcp-handler.ts`, `router.ts`, `applyTenantScope`) start consulting them in
-- the following change, so this one is a no-op for every existing key.
-- ═════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The columns
-- ─────────────────────────────────────────────────────────────────────────────

alter table api_tokens
  add column if not exists scopes     text[] not null default '{}',
  add column if not exists org_access text   not null default 'all',
  add column if not exists org_ids    uuid[] not null default '{}';

comment on column api_tokens.scopes is
  'Allowlist of scope patterns this key may touch. EMPTY = unrestricted. A '
  'pattern is a canonical scope, or an owner wildcard whose trailing "*" comes '
  'directly after a "/" or a "::" (repo::mthines/*), matched by '
  'lorekit_api_token_scope_allowed().';

comment on column api_tokens.org_access is
  'Tenancy this key may reach: all (every org the owner belongs to, plus '
  'personal), personal (personal rows only), selected (personal plus the orgs '
  'in org_ids).';

comment on column api_tokens.org_ids is
  'The orgs a "selected" key may reach. Non-empty if and only if org_access = '
  '''selected''.';

-- Bounded, so a key cannot become a thousand-element predicate evaluated on
-- every request. 50 is far past any real key and far short of a problem.
alter table api_tokens
  drop constraint if exists api_tokens_scopes_len;
alter table api_tokens
  add constraint api_tokens_scopes_len
  check (cardinality(scopes) <= 50);

-- Every element is a canonical scope or an owner wildcard. The charset mirrors
-- `expandScopeForSearch`'s injection guard exactly — see decision 3. The 200
-- ceiling is USAGE_SCOPE_MAX, reused so a scope that can be recorded is a scope
-- that can be allowlisted.
--
-- A helper function rather than an inline predicate because a CHECK cannot
-- contain a subquery, and "every element of an array satisfies P" needs one.
-- IMMUTABLE and total, so the constraint is index-safe and a NULL never slips
-- past it as "unknown, therefore fine".
create or replace function lorekit_api_token_scopes_valid(p_patterns text[])
returns boolean
language sql
immutable
as $$
  select p_patterns is null or not exists (
    select 1
    from unnest(p_patterns) as t(pattern)
    -- `is not true` rather than `!~`: a NULL ELEMENT makes both the regex and
    -- the length test NULL, the row is filtered out, and `not exists` reports
    -- the array valid — the unknown-therefore-fine case this gate exists to
    -- refuse.
    where (t.pattern ~ '^[a-z0-9._:/-]+(/|::)\*$' or t.pattern ~ '^[a-z0-9._:/-]+$') is not true
       or (length(t.pattern) <= 200) is not true
  );
$$;

comment on function lorekit_api_token_scopes_valid(text[]) is
  'Shape gate for api_tokens.scopes: each element is a canonical scope or an '
  'owner wildcard (a trailing ''*'' only after ''/'' or ''::''), over '
  'expandScopeForSearch''s charset, at most 200 chars. Total: a NULL element is '
  'INVALID, never unknown-therefore-fine.';

revoke execute on function lorekit_api_token_scopes_valid(text[]) from public, anon;
grant execute on function lorekit_api_token_scopes_valid(text[]) to authenticated, service_role;

alter table api_tokens
  drop constraint if exists api_tokens_scopes_shape;
alter table api_tokens
  add constraint api_tokens_scopes_shape
  check (lorekit_api_token_scopes_valid(scopes));

alter table api_tokens
  drop constraint if exists api_tokens_org_access_valid;
alter table api_tokens
  add constraint api_tokens_org_access_valid
  check (org_access in ('all', 'personal', 'selected'));

-- The list and the mode cannot disagree. Written as an equality of two booleans
-- rather than two implications so neither direction can be forgotten: a
-- 'selected' key with no orgs would be an unreachable key, and a 'personal' key
-- carrying org ids would be a lie the next reader believes.
alter table api_tokens
  drop constraint if exists api_tokens_org_ids_match_access;
alter table api_tokens
  add constraint api_tokens_org_ids_match_access
  check ((org_access = 'selected') = (cardinality(org_ids) > 0));

alter table api_tokens
  drop constraint if exists api_tokens_org_ids_len;
alter table api_tokens
  add constraint api_tokens_org_ids_len
  check (cardinality(org_ids) <= 50);

-- The org-list twin of the NULL-element rule `lorekit_api_token_scopes_valid`
-- enforces for `scopes`. Nothing above catches it: `{null}` has cardinality 1,
-- so both the length cap and the tenancy-match CHECK are satisfied, and a NULL
-- element is not a "no orgs" list — it is an unknown one, which on an
-- authorization column is the worst of the three answers.
--
-- `array_position` rather than a subquery because a CHECK cannot contain one,
-- and it is the subquery-free form: it compares with IS NOT DISTINCT FROM, so
-- it finds NULLs, and returns NULL (not 0) when there is no match.
alter table api_tokens
  drop constraint if exists api_tokens_org_ids_not_null;
alter table api_tokens
  add constraint api_tokens_org_ids_not_null
  check (array_position(org_ids, null) is null);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The predicates
--
-- Both are IMMUTABLE and take the key's stored columns as arguments rather than
-- a token id: the transports already hold the row after the hash lookup, and a
-- predicate that re-reads the table would turn one query per request into two.
-- They live in SQL — not only in the edge — because the write path's last
-- unbypassable gate is inside `memory_write`, which cannot call TypeScript.
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
      where case
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
  'allowlist = yes (unrestricted). NULL scope = no (fail closed).';

create or replace function lorekit_api_token_org_allowed(
  p_org_access text,
  p_org_ids uuid[],
  p_org_id uuid
)
returns boolean
language sql
immutable
as $$
  select case
    -- A personal row (org_id IS NULL) is reachable under every tenancy: the key
    -- belongs to that user, and 'personal' is a narrowing of which ORGS are
    -- reachable, never a revocation of the owner's own memories.
    when p_org_id is null then true
    when p_org_access = 'all' then true
    when p_org_access = 'personal' then false
    -- `coalesce(…, false)` is load-bearing: a NULL ELEMENT in p_org_ids makes
    -- `= any(…)` evaluate to NULL, and this function would then hand its caller
    -- NULL from an authorization predicate — neither true nor false. The
    -- api_tokens_org_ids_not_null CHECK stops such a row being written here, but
    -- this is precisely the function the comment below says is also fed rows
    -- from a BYOD install that may predate the CHECK, so it cannot rely on it.
    when p_org_access = 'selected'
      then coalesce(p_org_id = any(coalesce(p_org_ids, '{}'::uuid[])), false)
    -- Unreachable while api_tokens_org_access_valid holds; fail closed anyway,
    -- because this function is also called with values read back from a BYOD
    -- install whose bootstrap may predate the CHECK.
    else false
  end;
$$;

comment on function lorekit_api_token_org_allowed(text, uuid[], uuid) is
  'May a key with this tenancy reach a row owned by p_org_id (NULL = personal)? '
  'Authoritative over org_scope_bindings auto-routing — see 00067 decision 4.';

revoke execute on function lorekit_api_token_scope_allowed(text[], text) from public, anon;
revoke execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) from public, anon;
grant execute on function lorekit_api_token_scope_allowed(text[], text) to authenticated, service_role;
grant execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Setting the scoping — decision 5
--
-- The dashboard calls this with the user's own JWT session, so the actor is
-- `auth.uid()` and there is no caller-supplied user id to spoof (00046's rule,
-- applied to a table that had no UPDATE path at all).
-- ─────────────────────────────────────────────────────────────────────────────

-- No DEFAULTS on the three scoping arguments, deliberately. With them, a caller
-- that sent only `p_org_access` would silently reset `scopes` to `{}` — WIDENING
-- the key to every scope — because "omitted" and "clear this" would be the same
-- request. Requiring all three makes the full intended state explicit on every
-- call, so a partial update cannot fail open.
create or replace function lorekit_api_token_set_scoping(
  p_token_id uuid,
  p_scopes text[],
  p_org_access text,
  p_org_ids uuid[]
)
returns table (
  id uuid,
  scopes text[],
  org_access text,
  org_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_scopes   text[];
  v_org_ids  uuid[];
  v_owner    uuid;
  v_stray    uuid;
begin
  if v_actor is null then
    raise exception 'LK001: authentication required' using errcode = '28000';
  end if;

  -- These used to be `coalesce(p_scopes, '{}')` / `coalesce(p_org_ids, '{}')` in
  -- the declare block, which reopened the hole giving the arguments no DEFAULT
  -- was meant to close. No DEFAULT stops an OMITTED argument; the coalesce let
  -- an EXPLICIT null through and turned it into '{}' — and for `scopes`, '{}'
  -- means UNRESTRICTED (decision 1). So `set_scoping(id, null, 'all', '{}')`
  -- silently widened the key to every scope, which is exactly the fail-open
  -- partial update decision 5 refuses.
  --
  -- Refused rather than treated as "leave unchanged": that would make this a
  -- partial-update API that has to read and merge the current row, and decision
  -- 5 chose "state the full intended state on every call". Same reasoning, and
  -- now the same treatment, as the NULL `p_org_access` guard below.
  if p_scopes is null then
    raise exception 'LK004: scopes must not be null; pass an empty array to un-scope the key'
      using errcode = '22023';
  end if;

  if p_org_ids is null then
    raise exception 'LK004: org_ids must not be null; pass an empty array for a key with no orgs'
      using errcode = '22023';
  end if;

  v_scopes  := p_scopes;
  v_org_ids := p_org_ids;

  -- Ownership first, and by SELECT rather than by letting the UPDATE match zero
  -- rows: "you do not own this key" and "no such key" must be the same answer to
  -- the caller (no existence oracle), but they must be a real error rather than
  -- a silent no-op that the dashboard would render as success.
  select user_id into v_owner from api_tokens where api_tokens.id = p_token_id;
  if v_owner is null or v_owner <> v_actor then
    raise exception 'LK003: api token not found' using errcode = 'P0002';
  end if;

  -- Re-state the table's CHECKs here so a bad argument comes back as a legible
  -- LK004 the dashboard can render, not as a raw constraint-violation string
  -- naming an internal constraint. The CHECKs stay the authority — this is the
  -- error message, not the gate.
  if cardinality(v_scopes) > 50 then
    raise exception 'LK004: at most 50 scope patterns per key' using errcode = '22023';
  end if;

  if not lorekit_api_token_scopes_valid(v_scopes) then
    raise exception 'LK004: a scope pattern may contain only [a-z0-9._:/-], with an optional trailing "*" directly after a "/" or a "::"'
      using errcode = '22023';
  end if;

  if cardinality(v_org_ids) > 50 then
    raise exception 'LK004: at most 50 orgs per key' using errcode = '22023';
  end if;

  -- `is null or` is load-bearing, not defensive noise. `null not in (…)` is
  -- NULL, `if NULL` takes the false branch, and the `<>` guard below is NULL for
  -- the same reason — so a NULL tenancy would fall through BOTH re-statements
  -- and reach the UPDATE, where the column's NOT NULL rejects it as a raw 23502
  -- naming an internal constraint. That is the exact unreadable failure these
  -- re-statements exist to prevent. All three scoping arguments are now read
  -- raw and each carries its own explicit NULL refusal — `p_scopes` and
  -- `p_org_ids` above, this one here.
  --
  -- Refusing rather than coalescing to 'all' is deliberate: 'all' is the WIDEST
  -- tenancy, so defaulting a missing one would let an under-specified call widen
  -- the key — the same fail-open shape decision 5 refuses by giving the
  -- arguments no DEFAULT in the first place. That is also why the two arguments
  -- above are no longer coalesced: their default, '{}', means UNRESTRICTED.
  if p_org_access is null or p_org_access not in ('all', 'personal', 'selected') then
    raise exception 'LK004: org_access must be all, personal or selected'
      using errcode = '22023';
  end if;

  if (p_org_access = 'selected') <> (cardinality(v_org_ids) > 0) then
    raise exception 'LK004: org_ids must be non-empty for org_access=selected and empty otherwise'
      using errcode = '22023';
  end if;

  -- A key cannot be pointed at an org its OWNER cannot reach. Without this the
  -- column would be a wish rather than a restriction: the request-time check
  -- intersects with the owner's real membership anyway, so an unreachable org id
  -- would sit in the row looking like access that was granted. Rejecting it here
  -- keeps the row honest and the failure legible.
  -- A NULL ELEMENT has to go first, because the membership guard below cannot
  -- see it: a NULL org id IS selected into v_stray (`m.org_id = null` is NULL,
  -- so `not exists` is true), but then `v_stray is not null` is false and the
  -- raise never fires. Two layers of three-valued logic cancelling out into
  -- "looks like a member". The CHECK is the authority; this is the legible
  -- LK004, same division of labour as the other re-statements above.
  if array_position(v_org_ids, null) is not null then
    raise exception 'LK004: org_ids must not contain a null element'
      using errcode = '22023';
  end if;

  select t.org_id into v_stray
  from unnest(v_org_ids) as t(org_id)
  where not exists (
    select 1 from lorekit_member_org_ids(v_actor) as m(org_id)
    where m.org_id = t.org_id
  )
  limit 1;
  if v_stray is not null then
    raise exception 'LK002: not a member of org %', v_stray using errcode = '42501';
  end if;

  -- Qualified in RETURNING, bare on the left of SET — the shape `memory_write`
  -- has used since 00007, which is what keeps the OUT parameter names from
  -- colliding with the identically-named columns.
  return query
  update api_tokens
     set scopes     = v_scopes,
         org_access = p_org_access,
         org_ids    = v_org_ids
   where api_tokens.id = p_token_id
     and api_tokens.user_id = v_actor
  returning api_tokens.id, api_tokens.scopes, api_tokens.org_access, api_tokens.org_ids;
end;
$$;

comment on function lorekit_api_token_set_scoping(uuid, text[], text, uuid[]) is
  'Owner-only update of a key''s scope allowlist and tenancy. Actor is '
  'auth.uid(); org ids are validated against the actor''s own membership.';

revoke execute on function lorekit_api_token_set_scoping(uuid, text[], text, uuid[])
  from public, anon;
grant execute on function lorekit_api_token_set_scoping(uuid, text[], text, uuid[])
  to authenticated, service_role;
