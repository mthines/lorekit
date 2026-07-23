-- LoreKit memories table
-- Stores agent memory/lessons with canonical scope strings, full-text search, and RLS.

create table if not exists memories (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade,
  org_id       text,
  scope        text not null,
  key          text not null,
  value        text not null check (length(value) <= 65536),
  tags         text[] not null default '{}',
  source_agent text,
  trigger      text,
  -- Generated FTS column for full-text search via to_tsvector
  fts          tsvector generated always as (
    to_tsvector('english', coalesce(key, '') || ' ' || coalesce(value, ''))
  ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- user_id can be null for service-role writes (CI); uniqueness still holds
  constraint memories_user_scope_key_unique unique nulls not distinct (user_id, scope, key)
);

-- Indexes
create index if not exists memories_fts_idx    on memories using gin(fts);
create index if not exists memories_scope_idx  on memories (scope);
create index if not exists memories_user_idx   on memories (user_id);
create index if not exists memories_scope_key  on memories (scope, key);

-- Enable Row Level Security
alter table memories enable row level security;

-- Policy: users can read their own rows, or rows where org_id matches their JWT claim
create policy "rls_read"
  on memories for select
  using (
    user_id = auth.uid()
    or (
      org_id is not null
      and org_id = (auth.jwt() ->> 'org_id')
    )
  );

-- Policy: users can insert their own rows; service_role bypasses via superuser
create policy "rls_insert"
  on memories for insert
  with check (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- Policy: users can update their own rows
create policy "rls_update"
  on memories for update
  using (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- Policy: users can delete their own rows
create policy "rls_delete"
  on memories for delete
  using (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- Trigger to keep updated_at current
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger memories_updated_at
  before update on memories
  for each row execute function set_updated_at();
