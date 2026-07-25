-- Allow memory.write to backdate a memory's creation date (migration support).
--
-- When importing pre-existing memories into LoreKit, the caller can pass the
-- memory's ORIGINAL creation date so the dashboard dates it correctly instead
-- of showing the migration wall-clock time. This adds an optional
-- `p_created_at timestamptz` parameter to the memory_write RPC (00007).
--
-- Semantics:
--   • p_created_at IS NULL (default / not supplied): behaviour unchanged — the
--     insert uses now() for both created_at and updated_at.
--   • p_created_at supplied: the INSERT path sets BOTH created_at AND updated_at
--     to that value, so a freshly-migrated memory presents its original date in
--     every dashboard view (some order by created_at, some by updated_at) until
--     it is next edited. The app layer validates it and rejects future dates.
--   • The ON CONFLICT (update) path is unchanged: created_at is preserved (a
--     creation date never moves on a subsequent write) and updated_at = now().
--
-- Adding a parameter changes the function signature, so CREATE OR REPLACE alone
-- would leave a stale 7-arg overload behind and make PostgREST calls ambiguous.
-- Drop the old signature first, then create the widened one. Forward-only.

drop function if exists memory_write(uuid, text, text, text, text[], text, text);

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
returns table (id uuid, created_at timestamptz)
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
    returning memories.id, memories.created_at;
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
    returning memories.id, memories.created_at;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz)
  to anon, authenticated, service_role;
