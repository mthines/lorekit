-- ═════════════════════════════════════════════════════════════════════════
-- OAuth 2.1 authorization-code + PKCE support for the MCP server.
--
-- WHY
-- ---
-- Today the only way to attach an MCP client to LoreKit is to mint an `lk_*`
-- token in the dashboard and paste it into a config file. Every MCP host
-- (Claude Code, Cursor, ChatGPT, VS Code) now ships an "Authorize" affordance
-- that expects the RFC 9728 / RFC 8414 discovery + authorization-code-with-PKCE
-- dance instead. This migration adds the persistence those flows need.
--
-- THE AUTHORIZATION SERVER IS THE NEXT.JS APP (https://lorekit.io), NOT AN
-- EDGE FUNCTION. The consent screen has to render the caller's orgs, gate on a
-- real browser session, and reuse the existing Supabase-Auth cookie flow —
-- all of which already exist in `packages/web`. The MCP endpoint on
-- *.supabase.co stays the RESOURCE server: it only learns to advertise where
-- its authorization server lives, and to honour the extra columns below.
--
-- WHAT IT ADDS
-- ------------
--   oauth_clients              dynamically-registered public clients (RFC 7591)
--   oauth_authorization_codes  short-lived, single-use PKCE codes
--   api_tokens.*               four additive columns so an OAuth-issued
--                              credential is just an api_tokens row
--
-- DESIGN NOTES
-- ------------
--   * An OAuth access token IS an `api_tokens` row. It keeps the same
--     `lk_{rw|ro|wo}_` format and the same SHA-256 lookup, so the two
--     independent token-verification sites (mcp/auth.ts's `resolveAuth` and
--     _shared/api/auth.ts's `resolveRestAuth`) need one new expiry check
--     rather than a whole second credential type. Revocation, the 20-token
--     cap, the audit trail and the dashboard list all keep working unchanged.
--   * `api_tokens.org_ids` is the org allow-list the consent screen produced.
--     NULL means "every org the user is a member of, resolved per request" —
--     the pre-existing behaviour, so every existing row keeps its semantics
--     with no backfill. A non-NULL (possibly empty) array is an intersection
--     applied ON TOP of `lorekit_member_org_ids`, never instead of it:
--     leaving an org still revokes access even if the token still names it.
--   * There is deliberately NO client secret. MCP clients are public clients
--     that cannot keep one; PKCE (S256, mandatory) is the whole security
--     story, exactly as OAuth 2.1 prescribes.
--   * Codes are stored HASHED, like tokens — a leaked DB read must not yield a
--     usable credential. `consumed_at` makes replay detectable rather than
--     merely impossible.
--   * Both new tables are RLS-enabled with NO policies for the token/code rows
--     the flow writes: only the service-role client (the Next.js route
--     handlers, via createAdminClient()) touches them. `oauth_clients` gets no
--     select policy either — a registered client id is not user-scoped data.
--     This mirrors the orgs/org_members Phase-3 posture (00022): writes go
--     through a privileged server path, never a direct RLS-gated client write.
-- ═════════════════════════════════════════════════════════════════════════

-- ── Dynamically-registered clients (RFC 7591) ────────────────────────────
create table if not exists oauth_clients (
  -- The issued client identifier. Opaque, unguessable, generated server-side.
  client_id                  text primary key,
  client_name                text not null check (length(client_name) between 1 and 200),
  -- Exact-match allow-list. Every redirect_uri the client may be sent back to;
  -- an authorize request naming anything else is rejected before any consent
  -- screen renders. Bounded so a registration cannot be used as free storage.
  redirect_uris              text[] not null check (
    array_length(redirect_uris, 1) between 1 and 10
  ),
  -- Public clients only: PKCE is the proof, there is no secret to present.
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method = 'none'),
  grant_types                text[] not null default '{"authorization_code"}',
  -- Who registered it, when we can tell. Anonymous DCR (the common case for an
  -- MCP host discovering LoreKit for the first time) leaves this NULL.
  created_by                 uuid references auth.users on delete set null,
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz
);

alter table oauth_clients enable row level security;

-- ── Authorization codes ──────────────────────────────────────────────────
create table if not exists oauth_authorization_codes (
  -- SHA-256 hex of the issued code. The plaintext is never stored.
  code_hash             text primary key,
  client_id             text not null references oauth_clients(client_id) on delete cascade,
  -- Pinned at authorize time and re-checked at token time (RFC 6749 §4.1.3):
  -- a code minted for one redirect_uri may not be redeemed against another.
  redirect_uri          text not null,
  -- PKCE. S256 only — `plain` is forbidden by OAuth 2.1 and by the CHECK.
  code_challenge        text not null check (length(code_challenge) between 43 and 128),
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  user_id               uuid references auth.users on delete cascade not null,
  -- The consent decision, verbatim: which orgs, and which token permissions.
  org_ids               uuid[] not null default '{}',
  permissions           text[] not null default '{"read","write"}',
  -- The `scope` string the client asked for, verbatim. Stored only so the
  -- exchange can be correlated in the audit trail — the granted access is
  -- `permissions` + `org_ids` above, never this string. (`state` is a
  -- different parameter: it is echoed back on the authorize redirect for CSRF
  -- protection and is deliberately not persisted on this row.)
  scope                 text,
  expires_at            timestamptz not null,
  -- Single use. Set on the first successful exchange; a second attempt is a
  -- replay and MUST be treated as a compromised code, not merely ignored.
  consumed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_expiry_idx
  on oauth_authorization_codes(expires_at);
create index if not exists oauth_authorization_codes_user_idx
  on oauth_authorization_codes(user_id);

alter table oauth_authorization_codes enable row level security;

-- ── api_tokens: OAuth-issued credentials ─────────────────────────────────
-- All four are nullable/defaulted so every existing row keeps its exact
-- current meaning: kind='personal', no expiry, no org restriction, no client.
alter table api_tokens
  add column if not exists kind       text not null default 'personal',
  add column if not exists expires_at timestamptz,
  add column if not exists org_ids    uuid[],
  add column if not exists client_id  text references oauth_clients(client_id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_tokens_kind_check'
  ) then
    alter table api_tokens
      add constraint api_tokens_kind_check check (kind in ('personal', 'oauth'));
  end if;
end
$$;

-- An OAuth token always names the client it was issued to; a personal token
-- never does. Keeps the two populations distinguishable in the dashboard and
-- in the audit trail without a second table.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_tokens_oauth_client_check'
  ) then
    alter table api_tokens
      add constraint api_tokens_oauth_client_check check (
        (kind = 'oauth' and client_id is not null)
        or (kind = 'personal' and client_id is null)
      );
  end if;
end
$$;

-- Expiring tokens are swept by lorekit_purge_expired_oauth() below; the
-- partial index keeps that sweep and the auth-time expiry check cheap.
create index if not exists api_tokens_expires_idx
  on api_tokens(expires_at) where expires_at is not null;

-- ── Housekeeping ─────────────────────────────────────────────────────────
-- Codes live minutes and tokens live days, so both tables accumulate dead
-- rows. One SECURITY DEFINER sweeper, service-role only, callable from a cron
-- job or by hand. Consumed codes are kept for a grace period so a replay
-- attempt still finds the row and is recognised as a replay rather than as an
-- unknown code.
create or replace function lorekit_purge_expired_oauth()
returns table (codes_deleted integer, tokens_deleted integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codes  integer;
  v_tokens integer;
begin
  -- `auth.role()` reads the role claim PostgREST sets from a verified JWT, so
  -- it is NULL whenever there is no request context at all — pg_cron, psql,
  -- the dashboard SQL editor. Those callers are already gated by the
  -- REVOKE/GRANT below (00004 and 00034's reapers rely on that alone), so only
  -- a caller that DID present a JWT is checked here. Without the null arm the
  -- guard raises under pg_cron and the scheduled sweep can never run.
  if auth.role() is not null and auth.role() is distinct from 'service_role' then
    raise exception 'lorekit_purge_expired_oauth: service role required'
      using errcode = 'LK002';
  end if;

  delete from oauth_authorization_codes
   where expires_at < now() - interval '24 hours';
  get diagnostics v_codes = row_count;

  delete from api_tokens
   where kind = 'oauth'
     and expires_at is not null
     and expires_at < now();
  get diagnostics v_tokens = row_count;

  return query select v_codes, v_tokens;
end;
$$;

revoke all on function lorekit_purge_expired_oauth() from public;
grant execute on function lorekit_purge_expired_oauth() to service_role;
