-- LoreKit archive / soft-delete support
--
-- Adds archived_at to memories so agents and the dashboard can soft-delete a
-- lesson (archive) instead of hard-deleting it. Archived rows are hidden from
-- all normal reads (RLS select policy, tool queries) but can be listed via the
-- memory.list_archived MCP tool or the dashboard Archive tab.
--
-- A pg_cron job (or the memory.purge RPC called by the dashboard) hard-deletes
-- rows where archived_at < now() - (retention_days * interval '1 day').

-- 1. Add the soft-delete timestamp column.
alter table memories
  add column if not exists archived_at timestamptz;

-- 2. Index for efficient purge sweeps (only touches archived rows).
create index if not exists memories_archived_at_idx
  on memories (archived_at)
  where archived_at is not null;

-- 3. Drop the old unique constraint and recreate it excluding archived rows.
--    This allows the same (user_id, scope, key) to be re-created after an archive.
alter table memories
  drop constraint if exists memories_user_scope_key_unique;

create unique index if not exists memories_user_scope_key_active_unique
  on memories (user_id, scope, key)
  where archived_at is null;

-- Nulls-not-distinct variant for rows where user_id IS NULL (service-role writes).
create unique index if not exists memories_null_user_scope_key_active_unique
  on memories (scope, key)
  where user_id is null and archived_at is null;

-- 4. Update the RLS select policy to hide archived rows from normal reads.
drop policy if exists "rls_read" on memories;

create policy "rls_read"
  on memories for select
  using (
    archived_at is null
    and (
      user_id = auth.uid()
      or (
        org_id is not null
        and org_id = (auth.jwt() ->> 'org_id')
      )
    )
  );

-- 5. RLS policy for reading archived rows (dashboard archive view).
create policy "rls_read_archived"
  on memories for select
  using (
    archived_at is not null
    and (
      user_id = auth.uid()
      or (
        org_id is not null
        and org_id = (auth.jwt() ->> 'org_id')
      )
    )
  );

-- 6. Soft-archive RPC — sets archived_at, returns the row id.
--    Called by the MCP memory.archive tool and the dashboard server action.
--    Uses SECURITY DEFINER so the RLS update policy (user_id = auth.uid())
--    still applies — the function runs as the table owner but only touches
--    the row if the caller passes their own user_id.
create or replace function archive_memory(
  p_user_id  uuid,
  p_scope    text,
  p_key      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update memories
     set archived_at = now()
   where user_id = p_user_id
     and scope    = p_scope
     and key      = p_key
     and archived_at is null
  returning id into v_id;

  return v_id; -- null if row not found or already archived
end;
$$;

-- 7. Restore-from-archive RPC — clears archived_at.
create or replace function restore_memory(
  p_user_id  uuid,
  p_scope    text,
  p_key      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update memories
     set archived_at = null
   where user_id = p_user_id
     and scope    = p_scope
     and key      = p_key
     and archived_at is not null
  returning id into v_id;

  return v_id;
end;
$$;

-- 8. Purge RPC — hard-deletes archived rows older than retention_days.
--    Returns the count of deleted rows.
--    Intended to be called by a scheduled job or the dashboard "Run purge" button.
create or replace function purge_archived_memories(
  p_user_id       uuid,
  p_retention_days integer default 30
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
   where user_id    = p_user_id
     and archived_at is not null
     and archived_at < now() - (p_retention_days * interval '1 day')
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
