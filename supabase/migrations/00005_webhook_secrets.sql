-- LoreKit webhook secrets
-- Stores per-user HMAC secrets used to verify GitHub webhook payloads.
-- Secrets are stored in plaintext because:
--   1. They are Supabase-internal (the DB itself is the trust boundary).
--   2. The edge function needs the raw value to compute HMAC-SHA256 per request.
--   3. The dashboard needs to display the value once on first setup, matching
--      the api_tokens "show once" UX pattern (except this value IS retrievable
--      because the edge function needs to read it on every webhook call).
--
-- One active secret per user. Regenerating creates a new row and soft-deletes
-- the old one (active = false) so webhook deliveries in-flight don't fail
-- immediately — GitHub retries with the old secret for a short window.

create table if not exists webhook_secrets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users on delete cascade not null,
  secret     text not null check (length(secret) = 64),  -- 32 raw bytes → 64 hex chars
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists webhook_secrets_user_active_idx
  on webhook_secrets (user_id, active)
  where active = true;

alter table webhook_secrets enable row level security;

-- Users can read their own secrets (needed to display in the dashboard)
create policy "rls_webhook_secrets_select"
  on webhook_secrets for select
  using (user_id = auth.uid());

create policy "rls_webhook_secrets_insert"
  on webhook_secrets for insert
  with check (user_id = auth.uid());

create policy "rls_webhook_secrets_update"
  on webhook_secrets for update
  using (user_id = auth.uid());

-- Service role reads the active secret for HMAC verification on each webhook
-- call (bypasses RLS — no additional policy needed for service role).
