-- Distinguish memory.create from memory.update for audit logging (Decision D4).
--
-- memory_write() (00007, widened by 00009) performs an upsert — the caller
-- cannot otherwise tell whether the row was newly inserted or an existing
-- (scope, key) was updated. Postgres exposes this cheaply and atomically via
-- `xmax = 0` on the RETURNING clause: a freshly-inserted row's xmax is 0
-- (never yet updated/deleted by a transaction), while an ON CONFLICT DO
-- UPDATE path always leaves xmax set to the current transaction's id.
--
-- This is purely additive: a new `inserted boolean` column appended to the
-- RETURNS TABLE. Existing callers that read named fields (`id`, `created_at`)
-- are unaffected; packages/mcp-core/src/tools/write.ts and the edge mirror
-- (supabase/functions/mcp/tools.ts toolWrite) read the new field to record
-- `memory.create` vs `memory.update` in the audit log.
--
-- Widening the RETURNS TABLE changes the function's return signature, so
-- CREATE OR REPLACE alone is insufficient — drop the old signature first,
-- then create the widened one (same drop+recreate shape as 00009). Forward-only.

drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz);

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null
)
returns table (id uuid, created_at timestamptz, inserted boolean)
language plpgsql
set search_path = public
as $$
begin
  if p_user_id is null then
    -- service-role / CI writes: (scope, key) partial index for null user_id
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at)
    values (null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()))
    on conflict (scope, key) where user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax = 0) as inserted;
  else
    -- user-scoped writes (api_key / user): (user_id, scope, key) partial index
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at)
    values (p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()))
    on conflict (user_id, scope, key) where archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax = 0) as inserted;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz)
  to anon, authenticated, service_role;
