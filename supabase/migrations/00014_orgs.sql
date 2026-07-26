-- LoreKit organizations: server-side org entity + membership table.
--
-- Foundational schema for shared/team lore (org-owned memories land in
-- 00013/00014; the write path itself is Phase 2 — see plan.md). `orgs` is
-- the org identity; `org_members` is the SOLE membership-truth table.
-- `.lorekit/config.json` (Phase 4, advisory-only) never substitutes for it —
-- see CLAUDE.md.
--
-- lorekit_member_org_ids() is the SINGLE tenant-visibility predicate
-- source: both the memories RLS policies (00013) and the mirrored TS helper
-- (packages/mcp-core/src/tenant-scope.ts, applyTenantScope) consume its
-- result via RPC — never a hand-copied membership check. SECURITY DEFINER +
-- STABLE, mirroring the enforce_memory_cap()/lorekit_get_limit() pattern
-- (00004_limits.sql): keyed off the authenticated identity, never a
-- client-supplied claim.

create table if not exists orgs (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug = lower(slug)),
  name       text not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table orgs enable row level security;

create table if not exists org_members (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

alter table org_members enable row level security;

create index if not exists org_members_user_idx on org_members (user_id);

-- Members can read the orgs they belong to, and only their own membership
-- row. No insert/update/delete policy yet: Phase 3 (invite/accept server
-- actions, Supabase-JWT scoped) owns the membership write path — until then
-- only a service-role client can create orgs/memberships.
create policy "rls_orgs_select"
  on orgs for select
  using (
    id in (select org_id from org_members where user_id = auth.uid())
  );

create policy "rls_org_members_select"
  on org_members for select
  using (user_id = auth.uid());

create or replace trigger orgs_updated_at
  before update on orgs
  for each row execute function set_updated_at();

-- The single membership-truth function. STABLE (read-only, same result
-- within a statement) + SECURITY DEFINER so the memories RLS policy (00013)
-- can call it without granting SELECT on org_members directly, and so the
-- edge api_key path (service-role, RLS-bypass) gets identical semantics via
-- an explicit RPC call (see tenant-scope.ts). Reads ONLY org_members — never
-- memories — so it cannot recurse into the memories RLS policy that calls it.
create or replace function lorekit_member_org_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from org_members where user_id = p_user_id;
$$;

-- NOT granted to `anon`: the function takes a bare p_user_id, so an
-- unauthenticated caller with EXECUTE could enumerate any user's org
-- membership via PostgREST RPC. RLS policies that call it run as the
-- querying role, and only authenticated/service_role ever read `memories`.
grant execute on function lorekit_member_org_ids(uuid) to authenticated, service_role;
