-- Org sharing Phase 3, migration 1 of 3: the `org_invites` table + its RLS
-- read policies, and widening `org_members` visibility to co-members.
--
-- `org_invites` is the identity-bound invitation entity the 00012 migration
-- comment deferred to "Phase 3": a pending invite addressed to an email OR a
-- GitHub handle (never a forwardable share-link — see plan.md Decisions).
-- `role` deliberately excludes `owner` (ownership is non-transferable in v1 —
-- see plan.md Out of Scope #2) and `status` tracks the invite's lifecycle.
-- Only ONE pending invite may exist per (org, identity) — enforced by two
-- partial unique indexes, mirroring the `webhook_secrets` partial-unique
-- pattern (00008).
--
-- NO insert/update/delete RLS policy exists on `org_invites` — every mutation
-- (invite/revoke/accept/decline) is a SECURITY DEFINER RPC (00020) that
-- authorizes via `lorekit_org_can`, exactly like `org_members`/`orgs` before
-- it. RLS here governs reads only: an org's owners/admins see all its
-- invites; an invited user sees pending invites addressed to their VERIFIED
-- JWT identity claims (`email`, `user_metadata.user_name`) — never a
-- client-supplied identity string.
--
-- Also widens `rls_org_members_select` from own-row-only (00012) to all
-- co-members of a shared org, via `lorekit_org_role` (SECURITY DEFINER, reads
-- org_members bypassing RLS — the same anti-recursion shape used throughout
-- 00012/00015). The dashboard member list needs to show co-members; this
-- supersedes the Phase 1 own-row-only assertion in migrations.test.sql §7,
-- which is updated forward in the same PR (a test file, not a shipped
-- migration — see plan.md Decisions).

create table if not exists org_invites (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  invitee_email  text,                                    -- lowercased
  invitee_handle text,                                    -- lowercased GitHub handle
  role           text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  status         text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  invited_by     uuid references auth.users on delete set null,
  created_at     timestamptz not null default now(),
  responded_at   timestamptz,
  expires_at     timestamptz,
  check (invitee_email is not null or invitee_handle is not null)  -- identity-bound
);

-- One pending invite per (org, identity) — a second pending invite for the
-- same identity would be redundant/confusing; revoke or let it resolve first.
create unique index if not exists org_invites_pending_email_idx
  on org_invites (org_id, invitee_email) where status = 'pending' and invitee_email is not null;
create unique index if not exists org_invites_pending_handle_idx
  on org_invites (org_id, invitee_handle) where status = 'pending' and invitee_handle is not null;
create index if not exists org_invites_org_idx on org_invites (org_id);

alter table org_invites enable row level security;

-- Owners/admins of the org see all its invites (single-source capability
-- check — 'invite' is a management capability an owner/admin holds).
create policy "rls_org_invites_select_manage" on org_invites for select
  using (lorekit_org_can(auth.uid(), org_id, 'invite'));

-- The invited user sees pending invites addressed to their VERIFIED identity
-- claims — never a client-supplied string. auth.jwt() reads the request's
-- verified JWT (same GUC-backed function used throughout 00012/00015).
create policy "rls_org_invites_select_invitee" on org_invites for select
  using (
    status = 'pending' and (
      invitee_email  = lower(auth.jwt() ->> 'email') or
      invitee_handle = lower(auth.jwt() -> 'user_metadata' ->> 'user_name')
    )
  );

-- Widen member visibility from own-row-only (00012) to all co-members of a
-- shared org. lorekit_org_role is SECURITY DEFINER + STABLE and reads
-- org_members bypassing RLS, so this policy cannot recurse into itself.
drop policy "rls_org_members_select" on org_members;
create policy "rls_org_members_select" on org_members for select
  using (lorekit_org_role(auth.uid(), org_id) is not null);
