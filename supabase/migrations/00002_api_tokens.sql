-- LoreKit API tokens
-- Allows users to generate durable tokens for agent/CI authentication.
-- Tokens are NEVER stored in plain text — only as SHA-256 hashes.
-- The token prefix (first 12 chars) is stored for display/identification.
--
-- Token format: lk_{perm}_{32 random alphanumeric chars}
--   lk_rw_...  read+write  (all 5 MCP tools)
--   lk_ro_...  read-only   (memory.read, memory.list, memory.search only)

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade not null,
  name         text not null check (length(name) >= 1 and length(name) <= 100),
  -- First 12 chars + "..." for display ("lk_rw_aBcD1...") — safe to store, max 16 chars
  token_prefix text not null check (length(token_prefix) <= 16),
  -- SHA-256 hex of the full token — used for lookup on every request
  token_hash   text not null unique,
  -- Array of granted permissions: 'read' | 'write'
  permissions  text[] not null default '{"read","write"}',
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists api_tokens_user_idx      on api_tokens(user_id);
create index if not exists api_tokens_hash_idx      on api_tokens(token_hash);

alter table api_tokens enable row level security;

-- Users can only see and manage their own tokens
create policy "rls_api_tokens_select"
  on api_tokens for select
  using (user_id = auth.uid());

create policy "rls_api_tokens_insert"
  on api_tokens for insert
  with check (user_id = auth.uid());

create policy "rls_api_tokens_delete"
  on api_tokens for delete
  using (user_id = auth.uid());

-- Service role can look up tokens for auth validation (bypasses RLS)
-- No update policy needed — last_used_at is updated via service role
