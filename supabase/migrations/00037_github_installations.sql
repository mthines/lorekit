-- ═════════════════════════════════════════════════════════════════════════
-- GitHub App installation tracking.
--
-- A GitHub App installation covers one or more repositories and is identified
-- by a numeric installation_id.  When a user installs the LoreKit GitHub App,
-- GitHub delivers an `installation` event; the edge webhook handler (behind the
-- GITHUB_APP_ENABLED flag) reconciles that event here.
--
-- Authorization posture (the Phase 2 rule):
--   • The reconcile/upsert RPC is SECURITY DEFINER and is called only from the
--     edge function with the service-role key — never by an authenticated user
--     directly.  No caller-supplied user_id is trusted: the edge handler looks
--     up the GitHub account id in auth.users and supplies the resolved uuid, or
--     NULL for a pending installation.
--   • RLS on github_installations: a user reads only the rows that are linked
--     to their own auth.uid() (status='linked').  Pending rows (user_id IS NULL)
--     are invisible to authenticated users until reconciled.
--   • installation_repositories is readable only through the parent
--     github_installations row: the service role reads it; the dashboard reads
--     via a joined server action.
--
-- Fail-safe pending-identity:
--   An installation can arrive before any matching LoreKit user exists (e.g.,
--   installed from GitHub Marketplace before signing in).  Those installations
--   are stored with user_id = NULL + status = 'pending'.  A later login or
--   membership event that matches the github_account_id transitions them to
--   'linked'.  They are NEVER dropped.
--
-- Idempotency:
--   UNIQUE on installation_id + ON CONFLICT in the upsert RPC ensures that
--   redelivered `installation` events produce exactly one row.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. github_installations — one row per GitHub App installation.
create table github_installations (
  id                   uuid primary key default gen_random_uuid(),
  installation_id      bigint not null,
  github_account_id    bigint not null,
  github_account_login text   not null,
  account_type         text   not null check (account_type in ('User', 'Organization')),
  user_id              uuid   references auth.users(id) on delete set null,
  status               text   not null default 'pending'
                                check (status in ('pending', 'linked', 'removed')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index github_installations_installation_id_uniq
  on github_installations (installation_id);

create index github_installations_github_account_id_idx
  on github_installations (github_account_id);

create index github_installations_user_id_idx
  on github_installations (user_id)
  where user_id is not null;

alter table github_installations enable row level security;

-- Users can read only their own linked installations (pending rows with
-- user_id NULL are invisible to authenticated users by this policy).
create policy "rls_github_installations_select"
  on github_installations for select
  using (user_id = auth.uid() and status = 'linked');

grant select on github_installations to authenticated, service_role;

-- 2. installation_repositories — repos covered by an installation.
create table installation_repositories (
  id              uuid primary key default gen_random_uuid(),
  installation_id bigint not null references github_installations(installation_id) on delete cascade,
  full_name       text   not null,
  active          boolean not null default true,
  added_at        timestamptz not null default now(),
  removed_at      timestamptz
);

create index installation_repositories_installation_id_idx
  on installation_repositories (installation_id);

create index installation_repositories_full_name_idx
  on installation_repositories (full_name)
  where active = true;

-- Unique: one active row per (installation_id, full_name).
create unique index installation_repositories_active_uniq
  on installation_repositories (installation_id, full_name)
  where active = true;

alter table installation_repositories enable row level security;

-- Readable only by service_role (the edge function) and by authenticated users
-- whose matching github_installations row is linked to their uid.
create policy "rls_installation_repositories_select"
  on installation_repositories for select
  using (
    installation_id in (
      select i.installation_id
        from github_installations i
       where i.user_id = auth.uid() and i.status = 'linked'
    )
  );

grant select on installation_repositories to authenticated, service_role;

-- 3. Reconcile/upsert RPC — called by the edge function (service-role key).
--    SECURITY DEFINER: operates on github_installations as the definer (bypasses
--    RLS), so the edge function cannot accidentally trigger the authenticated
--    select policy.  Caller supplies a pre-resolved p_user_id (or NULL).
--    Idempotent: ON CONFLICT (installation_id) DO UPDATE.
create or replace function lorekit_installation_upsert(
  p_installation_id      bigint,
  p_github_account_id    bigint,
  p_github_account_login text,
  p_account_type         text,
  p_user_id              uuid,     -- NULL → pending
  p_status               text,     -- 'pending' | 'linked' | 'removed'
  p_repos                text[]    -- full_names to mark active; empty = no repo changes
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Upsert the installation row.
  insert into github_installations (
    installation_id, github_account_id, github_account_login, account_type,
    user_id, status, updated_at
  )
  values (
    p_installation_id, p_github_account_id, p_github_account_login, p_account_type,
    p_user_id, p_status, now()
  )
  on conflict (installation_id) do update set
    github_account_id    = excluded.github_account_id,
    github_account_login = excluded.github_account_login,
    account_type         = excluded.account_type,
    user_id              = case
                             -- Only overwrite user_id when transitioning to linked
                             -- or when updating an already-linked row.  A pending
                             -- install that re-delivers must not lose a previously
                             -- linked user_id.
                             when excluded.status = 'linked' then excluded.user_id
                             when github_installations.status = 'linked' then github_installations.user_id
                             else excluded.user_id
                           end,
    status               = case
                             -- Never regress from 'linked' to 'pending'.
                             when github_installations.status = 'linked'
                              and excluded.status = 'pending'
                             then 'linked'
                             else excluded.status
                           end,
    updated_at           = now()
  returning id into v_id;

  -- Upsert covered repos when provided.
  if array_length(p_repos, 1) is not null then
    -- Insert new active repo rows; skip if already active.
    insert into installation_repositories (installation_id, full_name, active, added_at)
    select p_installation_id, unnest(p_repos), true, now()
    on conflict (installation_id, full_name) where active = true
    do nothing;
  end if;

  return v_id;
end;
$$;

grant execute on function lorekit_installation_upsert(bigint, bigint, text, text, uuid, text, text[])
  to service_role;

-- 4. Remove repos covered by an installation (installation_repositories action='removed').
create or replace function lorekit_installation_remove_repos(
  p_installation_id bigint,
  p_repos           text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update installation_repositories
  set active = false, removed_at = now()
  where installation_id = p_installation_id
    and full_name = any(p_repos)
    and active = true;
end;
$$;

grant execute on function lorekit_installation_remove_repos(bigint, text[])
  to service_role;

-- 5. Mark an installation as removed (soft-delete its repo rows too).
create or replace function lorekit_installation_remove(
  p_installation_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update github_installations
  set status = 'removed', updated_at = now()
  where installation_id = p_installation_id;

  update installation_repositories
  set active = false, removed_at = now()
  where installation_id = p_installation_id
    and active = true;
end;
$$;

grant execute on function lorekit_installation_remove(bigint)
  to service_role;

-- 6. Identity lookup helper — given a GitHub numeric account id (stored as
--    text in auth.identities.provider_id), return the matching auth.users.id.
--    Used by the edge webhook handler to reconcile an installation to a LoreKit
--    user without exposing the auth schema through PostgREST.
--    Returns NULL when no matching user exists (pending path).
create or replace function lorekit_find_user_by_github_id(p_github_account_id text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.user_id
    from auth.identities i
   where i.provider = 'github'
     and i.provider_id = p_github_account_id
   limit 1;
$$;

grant execute on function lorekit_find_user_by_github_id(text)
  to service_role;
