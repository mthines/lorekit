-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_tags(p_user_id, p_archived) — the label (tags) catalog, for
-- GET /memories/tags.
--
-- WHY an RPC rather than a client-side tally: this is lorekit_memory_scopes
-- (00039) applied to the second unbounded dimension. The dashboard's label
-- filter built its catalog from `select tags from memories` plus a
-- client-side reduce (packages/web/src/lib/queries/lore.ts), which is
-- truncated without warning past PostgREST's row cap — so a label used only by
-- older memories vanishes from its own filter, and every count is understated.
-- One grouped row per distinct label is exact at any volume.
--
-- WHY it is archived-aware: the catalog must describe the population it will
-- filter. The Explorer renders the bar in both the active and the archived
-- view and `GET /memories` partitions on archived_at, so a catalog pinned to
-- active rows describes the wrong population in archived mode — wrong counts,
-- and archive-only labels missing entirely. p_archived selects the partition,
-- exactly as `?archived=` does on the list route.
--
-- Expiry: the active partition additionally excludes expired rows, matching
-- lorekit_memory_scopes and the default GET /memories predicate. The archived
-- partition does NOT — an archived row is out of the active set already, and
-- `?archived=true` on the list route applies no expiry filter either, so
-- applying one here would make the catalog disagree with the list it labels.
--
-- Ordering is count desc, then tag asc: the caller renders a picker, and a bar
-- that reshuffles under the cursor for equal counts is a usability bug. As with
-- every other read RPC here, plpgsql (not SQL) so the ORDER BY cannot be lost
-- to inlining.
--
-- Actor resolution, visibility and grants are the 00046/00047 rule verbatim —
-- a caller-supplied p_user_id is honoured only on a verified service-role
-- connection, and PUBLIC/anon get no EXECUTE (label names are as sensitive as
-- scope names: they are free text written by agents).
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_tags(
  p_user_id  uuid,
  p_archived boolean default false
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

revoke execute on function lorekit_memory_tags(uuid, boolean) from public, anon;
grant  execute on function lorekit_memory_tags(uuid, boolean) to authenticated, service_role;

comment on function lorekit_memory_tags(uuid, boolean) is
  'Label (memories.tags) catalog with per-label counts, for the partition
   selected by p_archived, visible to the EFFECTIVE caller. Same
   service-role-gated actor rule and tenant predicate as
   lorekit_memory_scopes. Ordered count desc, tag asc.';
