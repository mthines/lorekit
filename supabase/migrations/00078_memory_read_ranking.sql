-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_read_ranking — hot and cold lore, ranked by memories.read_count
-- (migration 00077).
--
-- THE PAYOFF: with per-memory counters in place, "these 40 lessons have not
-- been read since <cutover>" becomes a real ranked query instead of a shrug —
-- exactly the prune-list input the `lorekit-groom` skill exists to consume.
-- `hot` (read_count desc) surfaces the most-consumed lore; `cold` (read_count
-- asc, oldest-created first) surfaces the least.
--
-- COUNTING_SINCE / THE CUTOVER: `read_count = 0` on a memory created before
-- migration 00077 shipped is NOT "never read" — it is "not read since 00077
-- started counting". A memory written last year could have been read 200
-- times under the old, uncounted regime. This function returns no such date
-- itself (a SQL function has no honest way to know when its OWN migration was
-- applied to THIS database); the calling handler stamps it from a constant
-- recording that deploy date, and every consumer MUST render it rather than
-- the bare word "never" — see `ReadRankingResponseSchema.counting_since`.
--
-- SCOPE: active (non-archived, non-expired) memories only, mirroring
-- `lorekit_memory_scopes` (00065) — an archived memory is already pruned, so
-- ranking it for pruning again is noise. Same org-shared + own-rows visibility
-- predicate as every other per-user analytics RPC in this file family
-- (`lorekit_memory_scopes`, `lorekit_read_activity`), and the same
-- service-role + NULL actor escape hatch.
--
-- INDEX: `(user_id, read_count)` partial on `archived_at is null` — the
-- `memories_keyset_index` (00061) / `memory_scopes_order_by_count` (00065)
-- precedent for indexing an ordered analytics read. `now()` is intentionally
-- NOT in the partial predicate (a volatile function there defeats the
-- planner's ability to use the index for an unrelated snapshot) — the
-- non-expired filter is applied in the query body instead, exactly as 00065
-- does for its own scope rollup.
-- ═════════════════════════════════════════════════════════════════════════

create index if not exists memories_user_read_count_idx
  on memories (user_id, read_count)
  where archived_at is null;

create or replace function lorekit_memory_read_ranking(
  p_user_id    uuid,
  p_direction  text    default 'hot',
  p_scope      text    default null,
  p_limit      integer default 20,
  p_key_scopes text[]  default '{}'
)
returns table (
  id           uuid,
  scope        text,
  key          text,
  read_count   integer,
  last_read_at timestamptz,
  seen_count   integer,
  created_at   timestamptz
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if p_direction is null or p_direction not in ('hot', 'cold') then
    raise exception 'invalid direction %, expected hot or cold', p_direction
      using errcode = '22023';
  end if;

  return query
    select m.id, m.scope, m.key, m.read_count, m.last_read_at, m.seen_count, m.created_at
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_scope is null or m.scope = p_scope)
       -- A scoped API key (00068/00069) sees only ITS allowed scopes on an
       -- unfiltered call, the same narrowing lorekit_read_activity applies —
       -- an unscoped/JWT caller passes an empty p_key_scopes, under which
       -- lorekit_api_token_scope_allowed admits everything.
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
     order by
       case when p_direction = 'hot' then m.read_count end desc,
       case when p_direction = 'hot' then m.last_read_at end desc nulls last,
       case when p_direction = 'cold' then m.read_count end asc,
       case when p_direction = 'cold' then m.created_at end asc,
       m.id desc
     limit v_limit;
end;
$$;

revoke execute on function lorekit_memory_read_ranking(uuid, text, text, integer, text[]) from public, anon;
grant  execute on function lorekit_memory_read_ranking(uuid, text, text, integer, text[]) to authenticated, service_role;

comment on function lorekit_memory_read_ranking(uuid, text, text, integer, text[]) is
  'Memories ranked by read_count (migration 00077) — hot (most-read first) or
   cold (least-read, oldest-created first among ties). Active rows only
   (non-archived, non-expired), same org-shared + self visibility as
   lorekit_memory_scopes. read_count = 0 means "not read since 00077 started
   counting", never "never read" -- the calling handler must stamp and every
   consumer must render the counting_since qualifier. p_limit is clamped to
   [1, 100].';
