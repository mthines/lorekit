-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_usage_memory_count_peak — usage_events.memory_count surfaced.
--
-- THE GAP: `usage_events.memory_count` (migration 00034) is stamped on every
-- WRITE event with the account's active memory count at that moment, and is
-- exposed by no endpoint and no view. It is a free time series of "how full
-- is this account" that nothing reads.
--
-- NOT A REPLACEMENT for the existing live count: `/settings/plan` already
-- shows an ACCURATE, LIVE count via `lorekit_memory_count()` (00035, a real
-- `count(*)` against `memories`) in `PlanUsageBar`. That answers "how full
-- am I RIGHT NOW". `usage_events.memory_count` answers a different question
-- — "how full WAS I, over a window" — since it is a snapshot taken at each
-- write, not a live query. This migration adds the peak-over-a-window
-- reading alongside the existing live one, not instead of it.
--
-- WHY A SEPARATE SCALAR RPC, NOT A `lorekit_usage_stats` COLUMN:
-- `lorekit_usage_stats` groups by (tool_name, outcome, scope_type, client,
-- kind, host) — `memory_count` is a per-EVENT snapshot, not something that
-- sums or means sensibly across a group the way `event_count`/`record_count`
-- do. A `max(memory_count)` bolted onto that grouped return would repeat the
-- same scalar on every row for no reason. A dedicated single-value function
-- is the honest shape for a single-value answer.
--
-- NO LIMIT IS RETURNED OR HARDCODED HERE — this function answers "how full
-- WAS the account", not "how close to the cap". The caller already has the
-- limit from `lorekit_get_limit`/`lorekit_memory_count` and pairs the two
-- client-side, per the "no numeric limit hardcoded in app code" rule.
--
-- SERVICE-ROLE WITH NO TARGET USER returns NULL — there is no single
-- account's headroom to report for an unscoped service-role call, matching
-- `lorekit_usage_stats`'s own null-user semantics but returning null instead
-- of an account-wide aggregate (there is no "everyone's peak" that means
-- anything).
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_usage_memory_count_peak(
  p_user_id uuid,
  p_since   timestamptz default null,
  p_until   timestamptz default null
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := case
    when auth.role() = 'service_role' then p_user_id
    else auth.uid()
  end;
  v_peak integer;
begin
  -- No specific account to report on — service-role with no target user.
  if v_actor is null then
    return null;
  end if;

  select max(e.memory_count) into v_peak
    from usage_events e
   where e.user_id = v_actor
     and e.memory_count is not null
     and (p_since is null or e.created_at >= p_since)
     and (p_until is null or e.created_at <  p_until);

  return v_peak;
end;
$$;

revoke execute on function lorekit_usage_memory_count_peak(uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function lorekit_usage_memory_count_peak(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

comment on function lorekit_usage_memory_count_peak(uuid, timestamptz, timestamptz) is
  'The highest memories.count snapshot recorded on a WRITE event
   (usage_events.memory_count, migration 00034) in the half-open
   [p_since, p_until) window -- "how full WAS this account", distinct from
   lorekit_memory_count()''s live "how full is it now". Returns null for a
   service-role caller with no target user, or when the window has no write
   events at all. Self-only: v_actor is auth.uid() for a JWT caller and the
   verified service-role''s own p_user_id otherwise -- an authenticated
   caller can never pass another user''s id through p_user_id.';
