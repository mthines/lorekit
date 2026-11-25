-- ═════════════════════════════════════════════════════════════════════════
-- Memory graph (migration 00122): the connections between lore.
--
--   lorekit_memory_neighbours  — one memory's edges: co-cited, cites / cited-by,
--                                supersedes / superseded-by, and the runs it
--                                was credited in.
--   lorekit_memory_graph       — the corpus-level graph: co-cited pairs as
--                                weighted edges, plus read-but-never-used
--                                orphans, for the Insights "Connections" panel.
--
-- WHAT AN EDGE MEANS. The only run-level co-usage LoreKit records today is
-- `memory_citations` (00107): an agent crediting a lesson, tagged with the run's
-- `correlation_id`. Two lessons cited in the same run are "used together". Reads
-- carry no run id (`memory_read_daily`, 00084, is a day rollup), so a read-based
-- edge is a later migration — this one derives everything from data that exists.
--
-- Weight is the number of DISTINCT runs two lessons shared, never a row count:
-- the ledger is already one row per (cited, citing, run), but a lesson credited
-- by two retrospectives in one run must not read as two co-usages.
--
-- A citation with NO correlation id cannot be placed in a run, so it makes no
-- co-cited edge. It still makes `cites` / `cited_by` edges through
-- `citing_memory_id`.
--
-- VISIBILITY: the owner's PERSONAL lore only (`user_id = actor and org_id is
-- null`), active rows, narrowed by a key's scope allowlist. NOT the org-widening
-- predicate the other analytics RPCs use: the citation ledger is personal only
-- (00107 deliberately does not resolve org lore), so an org lesson could only
-- ever appear here as an ORPHAN, and listing org lessons by scope + key through
-- an owner-keyed RPC would hand them to a key whose tenancy excludes them. Being
-- owner-keyed, the routes are refused to `orgs_only` keys (`OWNER_ROW_TOOLS`).
-- Edges are filtered on `memory_citations.user_id = actor`.
-- ═════════════════════════════════════════════════════════════════════════

-- The pair self-join below keys on (user_id, correlation_id) and then needs the
-- cited id; the existing partial index (00107) covers the first two but forces
-- a heap fetch for the third. Covering it keeps the join index-only.
create index if not exists memory_citations_user_correlation_cited_idx
  on memory_citations (user_id, correlation_id, cited_memory_id)
  where correlation_id is not null;
comment on index memory_citations_user_correlation_cited_idx is
  '00122: covers the co-cited self-join (user_id, correlation_id) -> cited_memory_id without a heap fetch.';

-- The drawer's "cites" lookup filters on citing_memory_id alone, and no index
-- leads with that column (00107's are keyed on user_id / cited_memory_id), so
-- without this every Connections expand scans the whole ledger. It also serves
-- the foreign key's ON DELETE SET NULL.
create index if not exists memory_citations_citing_idx
  on memory_citations (citing_memory_id)
  where citing_memory_id is not null;
comment on index memory_citations_citing_idx is
  '00122: serves lorekit_memory_neighbours cites lookup and the citing_memory_id FK cascade.';

-- ── 1. one memory's neighbourhood ────────────────────────────────────────
create or replace function lorekit_memory_neighbours(
  p_user_id    uuid,
  p_memory_id  uuid,
  p_limit      integer default 20,
  p_key_scopes text[]  default '{}'
)
returns table (
  kind           text,         -- co_cited | cited_by | cites | supersedes | superseded_by | run
  memory_id      uuid,         -- null for kind = 'run'
  scope          text,
  key            text,
  weight         integer,      -- shared runs (co_cited) / citations; 1 for lineage
  last_at        timestamptz,
  correlation_id text,         -- kind = 'run' only
  session_kind   text          -- kind = 'run' only
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_super uuid;
begin
  -- The focus memory must itself be visible to the caller. A memory the caller
  -- cannot see yields NO rows — indistinguishable from "no connections", so the
  -- route is not an existence oracle for someone else's id.
  if not exists (
    select 1 from memories f
     where f.id = p_memory_id
       and (
             (v_actor is null and auth.role() = 'service_role')
             or (f.user_id = v_actor and f.org_id is null)
           )
       and lorekit_api_token_scope_allowed(p_key_scopes, f.scope)
  ) then
    return;
  end if;

  select f.supersedes into v_super from memories f where f.id = p_memory_id;

  return query
  with visible as (
    select m.id, m.scope, m.key
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or (m.user_id = v_actor and m.org_id is null)
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
  ),
  -- lessons cited in the same run as the focus memory
  co as (
    select b.cited_memory_id as other_id,
           count(distinct a.correlation_id)::integer as w,
           max(a.created_at) as last_at
      from memory_citations a
      join memory_citations b
        on b.user_id = a.user_id
       and b.correlation_id = a.correlation_id
       and b.cited_memory_id <> a.cited_memory_id
     where a.cited_memory_id = p_memory_id
       and a.correlation_id is not null
       and (v_actor is null or a.user_id = v_actor)
     group by b.cited_memory_id
  ),
  -- retrospectives that credited the focus memory
  cby as (
    select c.citing_memory_id as other_id, count(*)::integer as w, max(c.created_at) as last_at
      from memory_citations c
     where c.cited_memory_id = p_memory_id
       and c.citing_memory_id is not null
       and (v_actor is null or c.user_id = v_actor)
     group by c.citing_memory_id
  ),
  -- lessons the focus memory (as a retrospective) credited
  cts as (
    select c.cited_memory_id as other_id, count(*)::integer as w, max(c.created_at) as last_at
      from memory_citations c
     where c.citing_memory_id = p_memory_id
       and (v_actor is null or c.user_id = v_actor)
     group by c.cited_memory_id
  ),
  edges as (
    select 'co_cited'::text as kind, co.other_id, co.w, co.last_at from co
    union all select 'cited_by',  cby.other_id, cby.w, cby.last_at from cby
    union all select 'cites',     cts.other_id, cts.w, cts.last_at from cts
    union all select 'supersedes', v_super, 1, null::timestamptz where v_super is not null
    union all select 'superseded_by', s.id, 1, s.updated_at
      from memories s where s.supersedes = p_memory_id
  ),
  ranked as (
    select e.kind, v.id as memory_id, v.scope, v.key, e.w as weight, e.last_at,
           row_number() over (partition by e.kind order by e.w desc, e.last_at desc nulls last, v.id) as rn
      from edges e
      join visible v on v.id = e.other_id
  ),
  runs as (
    select c.correlation_id,
           max(c.created_at) as last_at,
           count(*)::integer as cited_count
      from memory_citations c
     where c.cited_memory_id = p_memory_id
       and c.correlation_id is not null
       and (v_actor is null or c.user_id = v_actor)
     group by c.correlation_id
     order by max(c.created_at) desc
     limit v_limit
  )
  select r.kind, r.memory_id, r.scope, r.key, r.weight, r.last_at,
         null::text, null::text
    from ranked r
   where r.rn <= v_limit
  union all
  select 'run'::text, null::uuid, null::text, null::text, rn.cited_count, rn.last_at,
         rn.correlation_id,
         (select max(u.session_kind) from usage_events u
           where u.correlation_id = rn.correlation_id
             and (v_actor is null or u.user_id = v_actor))
    from runs rn;
end;
$$;

revoke execute on function lorekit_memory_neighbours(uuid, uuid, integer, text[]) from public, anon;
grant  execute on function lorekit_memory_neighbours(uuid, uuid, integer, text[]) to authenticated, service_role;

comment on function lorekit_memory_neighbours(uuid, uuid, integer, text[]) is
  'One memory''s edges (migration 00122): co_cited (cited in the same run),
   cited_by / cites (through citing_memory_id), supersedes / superseded_by, and
   the runs it was credited in. Weight = distinct shared runs. Yields nothing for
   a memory the caller cannot see. p_limit is clamped to [1, 50] per kind.';

-- ── 2. the corpus graph ──────────────────────────────────────────────────
create or replace function lorekit_memory_graph(
  p_user_id      uuid,
  p_scope        text    default null,
  p_min_weight   integer default 1,
  p_limit_nodes  integer default 150,
  p_since        timestamptz default null,
  p_key_scopes   text[]  default '{}'
)
returns jsonb
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
  v_limit  integer := least(greatest(coalesce(p_limit_nodes, 150), 10), 300);
  v_minw   integer := greatest(coalesce(p_min_weight, 1), 1);
  v_result jsonb;
begin
  with visible as (
    select m.id, m.scope, m.key, m.read_count, m.opened_count, m.cited_count, m.last_read_at
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or (m.user_id = v_actor and m.org_id is null)
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_scope is null or m.scope = p_scope or m.scope like p_scope || '::%')
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
  ),
  pairs as (
    select a.cited_memory_id as src, b.cited_memory_id as dst,
           count(distinct a.correlation_id)::integer as w,
           max(a.created_at) as last_at
      from memory_citations a
      join memory_citations b
        on b.user_id = a.user_id
       and b.correlation_id = a.correlation_id
       and b.cited_memory_id > a.cited_memory_id
     where a.correlation_id is not null
       and (v_actor is null or a.user_id = v_actor)
       and (p_since is null or a.created_at >= p_since)
     group by a.cited_memory_id, b.cited_memory_id
    having count(distinct a.correlation_id) >= v_minw
  ),
  vis_pairs as (
    select p.src, p.dst, p.w, p.last_at
      from pairs p
      join visible s on s.id = p.src
      join visible d on d.id = p.dst
  ),
  degree as (
    select id, count(*)::integer as degree, sum(w)::integer as strength
      from (
        select src as id, w from vis_pairs
        union all
        select dst as id, w from vis_pairs
      ) x
     group by id
  ),
  top_connected as (
    select d.id, d.degree
      from degree d
     order by d.strength desc, d.degree desc, d.id
     limit v_limit
  ),
  -- read, never credited and never opened: the archive candidates
  orphans as (
    select v.id
      from visible v
     where v.read_count > 0
       and v.opened_count = 0
       and v.cited_count = 0
       and v.id not in (select id from degree)
     order by v.read_count desc, v.id
     limit 40
  ),
  keep as (
    select id from top_connected
    union
    select id from orphans
  ),
  nodes as (
    select v.id, v.scope, v.key, v.read_count, v.opened_count, v.cited_count,
           coalesce(t.degree, 0) as degree,
           (t.id is null) as orphan
      from visible v
      join keep k on k.id = v.id
      left join top_connected t on t.id = v.id
  ),
  edges as (
    select p.src, p.dst, p.w, p.last_at
      from vis_pairs p
     where p.src in (select id from top_connected)
       and p.dst in (select id from top_connected)
  )
  select jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'scope', n.scope, 'key', n.key,
        'read_count', n.read_count, 'opened_count', n.opened_count,
        'cited_count', n.cited_count, 'degree', n.degree, 'orphan', n.orphan
      ) order by n.degree desc, n.id) from nodes n), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(jsonb_build_object(
        'source', e.src, 'target', e.dst, 'weight', e.w, 'last_at', e.last_at
      ) order by e.w desc, e.src, e.dst) from edges e), '[]'::jsonb),
    'truncated', (select count(*) from degree) > v_limit
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) from public, anon;
grant  execute on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) to authenticated, service_role;

comment on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) is
  'Corpus co-usage graph (migration 00122): lessons cited in the same run are
   joined by an edge weighted by distinct shared runs. Returns {nodes, edges,
   truncated}. Nodes are the p_limit_nodes (clamped to [10, 300]) most strongly
   connected lessons plus up to 40 orphans (read, never opened or credited).
   Active PERSONAL rows only; personal citation ledger only (00107).';
