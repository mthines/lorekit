-- Fix memory.write against the partial unique indexes introduced in 00003.
--
-- 00003 dropped the plain `memories_user_scope_key_unique` constraint and
-- replaced it with two PARTIAL unique indexes (WHERE archived_at IS NULL):
--   • memories_user_scope_key_active_unique      (user_id, scope, key)
--   • memories_null_user_scope_key_active_unique  (scope, key) WHERE user_id IS NULL
--
-- A plain `.upsert(..., { onConflict: 'user_id,scope,key' })` cannot target a
-- partial index — Postgres raises "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification", so every write failed. `supabase-js`
-- can't express a partial-index arbiter, so writes go through this RPC, which
-- branches on whether user_id is null and names the matching partial index
-- predicate in ON CONFLICT.
--
-- Behaviour preserved: the BEFORE INSERT memory-cap trigger still fires on the
-- insert path (not on conflict-update); archived rows are excluded, so a
-- (user_id, scope, key) can be re-created after it is archived.

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[] default '{}',
  p_source_agent text   default null,
  p_trigger      text   default null
)
returns table (id uuid, created_at timestamptz)
language plpgsql
set search_path = public
as $$
begin
  if p_user_id is null then
    -- service-role / CI writes: (scope, key) partial index for null user_id
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, updated_at)
    values (null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger, now())
    on conflict (scope, key) where user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at;
  else
    -- user-scoped writes (api_key / user): (user_id, scope, key) partial index
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, updated_at)
    values (p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger, now())
    on conflict (user_id, scope, key) where archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text)
  to anon, authenticated, service_role;
