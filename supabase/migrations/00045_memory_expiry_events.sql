-- G3 — make expiry OBSERVABLE ("6 lessons got expired").
--
-- Expiry was invisible to analytics: TTL'd rows are filtered out of reads
-- (expires_at in the past) but no event marks the moment, and
-- purge_expired_memories deleted them while returning only a count the caller
-- usually discarded. There is no other discrete "expired" moment to hook — a
-- lazy read never deletes, it just excludes — so the purge is the right and
-- only pattern-fitting seam: capture the count it already computes as a usage
-- event instead of throwing it away.
--
-- purge_expired_memories now records ONE usage_events row per run that deleted
-- anything, tool_name 'memory.expired', result_count = rows expired. GET
-- /memories/usage then surfaces `expired` = sum(record_count) over that bucket.
-- The signature and return value are unchanged, so every existing caller (the
-- memory.purge_expired MCP tool, POST /memories/purge-expired) is unaffected —
-- and both of those still record their own 'memory.purge_expired' CALL event, so
-- the call and its effect stay distinct.
--
-- Forward-only: CREATE OR REPLACE, same signature as 00030.

create or replace function purge_expired_memories(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from memories
   where user_id     = p_user_id
     and expires_at  is not null
     and expires_at  < now()
     and archived_at is null   -- archived rows stay with purge_archived_memories
  ;
  get diagnostics v_count = row_count;

  -- Emit an expiry event so the count is tallyable per period/scope. Only when
  -- something actually expired — an empty purge is not an expiry event.
  -- lorekit_record_usage_event swallows its own errors, so this can never break
  -- the purge; auth_type 'service' marks it as a system-generated effect (it is
  -- not a caller read/write). Depends on 00044's added p_result_count param.
  if v_count > 0 then
    perform lorekit_record_usage_event(
      p_user_id      => p_user_id,
      p_tool_name    => 'memory.expired',
      p_scope_type   => null,
      p_auth_type    => 'service',
      p_outcome      => 'ok',
      p_result_count => v_count
    );
  end if;

  return v_count;
end;
$$;
