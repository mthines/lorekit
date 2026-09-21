-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_relevant_candidates — the candidate set behind
-- `GET /memories/relevant`, selected and GRADED by Postgres.
--
-- WHAT THIS REPLACES, and why it had to become an RPC. The handler used to
-- build the candidate fetch with PostgREST:
--
--     .textSearch('fts', q, { type: 'websearch', config: 'english' })
--     .order('updated_at', { ascending: false })
--     .limit(CANDIDATE_LIMIT)
--
-- which buys two honest limits the handler documented and could not fix from
-- the TypeScript side:
--
--   1. RELEVANCE WAS BINARY. `ts_rank`/`ts_rank_cd` is not projectable through
--      PostgREST's query grammar, so a row that matched scored 1 and a row
--      that did not was never returned — nothing scored between. Ordering
--      among matches was decided entirely by recency and salience.
--   2. THE CANDIDATE WINDOW WAS CUT BY RECENCY, NOT BY RANK. On a store with
--      more matching rows than the cap, the best-matching lesson could simply
--      fall outside the window and never be scored at all.
--
-- Both are the same fix: choose and grade the candidates IN Postgres. This
-- function returns the `RELEVANT_SELECT` projection plus a `relevance` column
-- = `ts_rank_cd(fts, websearch_to_tsquery('english', p_q))`, and — when a
-- query is supplied — cuts the window in RANK order instead of recency order.
--
-- DETERMINISTIC AND EMBEDDING-FREE, BY CONSTRUCTION. `ts_rank_cd` is a pure,
-- reproducible Postgres function over the same `fts` column `POST
-- /memories/search` already matches on. There is no model, no vector index and
-- no external call anywhere on this path: the same request against the same
-- rows returns the same rows in the same order, run to run. That is a
-- deliberate product decision, not an implementation detail — see
-- docs/decisions.md → "Graded relevance is lexical `ts_rank_cd`, never a
-- vector score".
--
-- WHY `ts_rank_cd` AND NOT `ts_rank`. Cover density rewards query terms that
-- appear CLOSE TOGETHER, which is the signal that separates a lesson actually
-- about "migration backfill" from one that mentions migrations in its first
-- paragraph and backfills in its last. `ts_rank` counts occurrences without
-- regard to proximity and would rank the second one just as highly.
--
-- THE SCORER STILL LIVES IN TYPESCRIPT. This function does NOT rank — it
-- SELECTS and GRADES. The composite score stays in the shared
-- `lesson-rank.ts`/`lessons-pure.mjs` pair, because it is set-relative
-- (salience normalises against the most-recurring candidate) and must agree
-- exactly with the CLI hook's ordering, an agreement `lesson-rank-parity.spec.ts`
-- can only hold two TypeScript-family implementations to. A plpgsql third copy
-- would be unguardable. The split is unchanged: Postgres selects, TypeScript
-- orders — this migration only makes the SELECT side say how well each row
-- matched instead of merely that it did.
--
-- TENANCY IS COMPOSED, NEVER RE-DERIVED. Three predicates, each the same
-- function its TypeScript counterpart mirrors:
--   * `lorekit_member_org_ids` — the single tenant-visibility source (00014),
--     exactly as `rls_read` (00015) and every sibling analytics RPC
--     (`lorekit_memory_read_ranking` 00085, `lorekit_read_activity`) ask it.
--   * `lorekit_api_token_org_allowed` (00068) — the SQL twin of
--     `effectiveOrgIds`/`ownRowsFragment` in `tenant-scope.ts`. Membership AND
--     the key's tenancy, which is the intersection the TypeScript filter
--     computes; a personal row (`org_id is null`) stays reachable under every
--     tenancy, and the owner's OWN org-owned rows drop out under a restricted
--     key — the case a bare `user_id = v_actor` disjunct would wrongly admit.
--   * `lorekit_api_token_scope_allowed` (00068/00069) — the SQL twin of
--     `keyScopeFilter`. A malformed stored pattern is dropped on both sides,
--     so a key can only ever be narrowed by one.
-- `security definer` (00085's shape) rather than invoker: the api_key tier
-- calls this on the SERVICE-ROLE client, where invoker would mean no RLS and
-- no predicate at all. Definer gives ONE predicate serving both auth tiers
-- instead of a predicate for one and RLS for the other.
--
-- INDEXES: no new index. The `q` path is an `fts @@ tsquery` match served by
-- `memories_fts_idx` (00001, GIN); the no-`q` path is `updated_at desc, id
-- desc` served by `memories_user_updated_at_id_idx` (00096). `ts_rank_cd` is
-- evaluated only over rows the index already returned — it is a recheck on a
-- bounded set, never a scan driver.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_relevant_candidates(
  p_user_id    uuid,
  p_q          text    default null,
  p_scopes     text[]  default '{}',
  p_key_scopes text[]  default '{}',
  p_key_org_access text    default 'all',
  p_key_org_ids    uuid[]  default '{}',
  p_limit      integer default 200
)
returns table (
  scope      text,
  key        text,
  value      text,
  seen_count integer,
  updated_at timestamptz,
  tags       text[],
  origin_pr  integer,
  relevance  double precision
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
  -- Clamped the same way every sibling analytics RPC clamps: the caller names
  -- the candidate cap, but the cap is this function's cost ceiling, not the
  -- caller's to raise without bound.
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  -- NULL and '' are BOTH "no query", matching the handler's `if (params.q)`
  -- falsiness exactly so the pre-RPC behaviour is preserved byte for byte.
  --
  -- A non-empty `p_q` whose tsquery comes back EMPTY (every term a stopword,
  -- e.g. 'the') is deliberately NOT folded into the no-query path: an empty
  -- tsquery matches nothing, so such a request returns no candidates — which
  -- is exactly what the PostgREST `.textSearch` form did. Folding it into "no
  -- query" would silently turn a request that asked a question into the
  -- unfiltered recency list, which is a different answer, not a better one.
  v_query tsquery := case
    when p_q is null or p_q = '' then null
    else websearch_to_tsquery('english', p_q)
  end;
begin
  return query
    select
      m.scope,
      m.key,
      m.value,
      m.seen_count,
      m.updated_at,
      m.tags,
      m.origin_pr,
      -- NULL when no query was asked — the absence of a relevance opinion,
      -- which the handler maps to 0 exactly as the binary form did. `greatest(
      -- …, 0)` is a floor, not a clamp: ts_rank_cd is non-negative by
      -- definition, and the floor documents that an authorization-adjacent
      -- numeric never leaves this function negative.
      case
        when v_query is null then null::double precision
        else greatest(ts_rank_cd(m.fts, v_query), 0)::double precision
      end as relevance
      from memories m
     where (
             -- Service-role with no actor (CI) reads everything, the same
             -- escape hatch 00085 carries.
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       -- Active lore only — the partition every read path applies. An archived
       -- or expired lesson is not a candidate for "what should I read".
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and lorekit_api_token_org_allowed(
             coalesce(p_key_org_access, 'all'),
             coalesce(p_key_org_ids, '{}'::uuid[]),
             m.org_id
           )
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and (coalesce(cardinality(p_scopes), 0) = 0 or m.scope = any(p_scopes))
       and (v_query is null or m.fts @@ v_query)
     order by
       -- RANK FIRST when there is a rank to sort by — this is the half that
       -- closes the "recency-windowed, not global" caveat. With no query every
       -- row's sort key is NULL, so the expression collapses and the ordering
       -- is the pre-RPC `updated_at desc, id desc` exactly.
       case when v_query is null then null else ts_rank_cd(m.fts, v_query) end
         desc nulls last,
       m.updated_at desc,
       -- The total-order tie-break. Without it the set that survives the cap
       -- could differ between two identical requests, which is the one way
       -- this endpoint could be non-deterministic without any caller being
       -- able to see why.
       m.id desc
     limit v_limit;
end;
$$;

revoke execute on function lorekit_memory_relevant_candidates(uuid, text, text[], text[], text, uuid[], integer)
  from public, anon;
grant execute on function lorekit_memory_relevant_candidates(uuid, text, text[], text[], text, uuid[], integer)
  to authenticated, service_role;

comment on function lorekit_memory_relevant_candidates(uuid, text, text[], text[], text, uuid[], integer) is
  'Candidate rows for GET /memories/relevant, graded by ts_rank_cd over the
   memories.fts column. With p_q set the window is cut in RANK order (closing
   the recency-window caveat) and relevance is the raw, unbounded ts_rank_cd
   value -- the caller normalises it into [0,1]. With p_q null or empty the
   window is cut in updated_at desc order and relevance is NULL. Active rows
   only (non-archived, non-expired). Visibility is lorekit_member_org_ids
   narrowed by lorekit_api_token_org_allowed and lorekit_api_token_scope_allowed,
   so it can never be wider than the RLS read policy or the calling key.
   Deterministic and embedding-free: no model, no vector index, no external
   call. p_limit is clamped to [1, 1000].';
