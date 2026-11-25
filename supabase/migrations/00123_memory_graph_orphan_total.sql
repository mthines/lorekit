-- ═════════════════════════════════════════════════════════════════════════
-- 00123_memory_graph_orphan_total — report the true orphan count
-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_graph (00122) lists at most 40 orphans, and the Insights panel
-- printed that cap as if it were the count. The function is re-created with the
-- SAME signature, visibility predicate and tenant filter; the only change is a
-- new `orphan_total` key: how many lessons meet the orphan predicate, uncapped.
-- ═════════════════════════════════════════════════════════════════════════

-- ── the corpus graph, now with the uncapped orphan total ─────────────────
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
  -- every orphan, uncapped: the panel states the true count beside the 40 it lists
  orphans_all as (
    select v.id, v.read_count
      from visible v
     where v.read_count > 0
       and v.opened_count = 0
       and v.cited_count = 0
       and v.id not in (select id from degree)
  ),
  orphans as (
    select o.id
      from orphans_all o
     order by o.read_count desc, o.id
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
    'truncated', (select count(*) from degree) > v_limit,
    'orphan_total', (select count(*) from orphans_all)::integer
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) from public, anon;
grant  execute on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) to authenticated, service_role;

comment on function lorekit_memory_graph(uuid, text, integer, integer, timestamptz, text[]) is
  'Corpus co-usage graph (migrations 00122, 00123): lessons cited in the same run are
   joined by an edge weighted by distinct shared runs. Returns {nodes, edges,
   truncated, orphan_total}; orphan_total counts EVERY orphan, the list is capped at 40. Nodes are the p_limit_nodes (clamped to [10, 300]) most strongly
   connected lessons plus up to 40 orphans (read, never opened or credited).
   Active PERSONAL rows only; personal citation ledger only (00107).';
