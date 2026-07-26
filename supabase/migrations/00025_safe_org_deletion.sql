-- ═════════════════════════════════════════════════════════════════════════
-- Safe org deletion — soft-delete + retention + explicit purge.
--
-- The #73 ON DELETE CASCADE discussion resolved to KEEP the cascade (an org's
-- memberships/invites/limits and its `memories.org_id` FK all cascade on a real
-- delete) and add RECOVERY one layer above it: `lorekit_org_delete` now
-- SOFT-deletes (stamps `orgs.deleted_at`), and a separate owner-only
-- `lorekit_org_purge` performs the real cascading delete as an explicit second
-- step (the permanent-delete / future grace-period-job path).
--
-- A soft-deleted org's lore disappears from every member's reads through ONE
-- change: `lorekit_member_org_ids()` (the single tenant-visibility predicate,
-- consumed by both the `memories` RLS read policies AND the mirrored TS
-- `applyTenantScope`, which reads this function's OUTPUT list) now excludes
-- soft-deleted orgs. No read-path code outside this function changes; the
-- `tenant-scope.ts` mirror and its drift guards (edge-parity / tenant-scope-usage)
-- stay green because the function's contract (a list of visible org ids) is
-- unchanged — only its result shrinks.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. The soft-delete marker. Nullable; NULL = live (the overwhelming majority),
--    a timestamp = soft-deleted at that instant. Added BEFORE the function
--    recreate below so the join target exists.
alter table orgs add column if not exists deleted_at timestamptz;

-- 2. Re-create the single membership-truth function to hide soft-deleted orgs.
--    Signature / STABLE / SECURITY DEFINER / search_path all preserved verbatim
--    from 00014 — only the body gains the `orgs` join + `deleted_at is null`
--    filter. Because the memories RLS policies and the edge `applyTenantScope`
--    helper both route through this function, a soft-deleted org's memories
--    vanish from ALL reads with no other change.
create or replace function lorekit_member_org_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select om.org_id
  from org_members om
  join orgs o on o.id = om.org_id
  where om.user_id = p_user_id
    and o.deleted_at is null;
$$;

grant execute on function lorekit_member_org_ids(uuid) to authenticated, service_role;

-- 3. The `orgs` SELECT policy (00014) uses a DIRECT org_members subquery, not
--    `lorekit_member_org_ids`, so it must be changed explicitly — otherwise a
--    soft-deleted org would still be directly readable via a `from orgs` select
--    (e.g. the org switcher). `rls_org_limits_select` (00018) DOES route through
--    the function above, so it is hidden transitively with no change here.
drop policy if exists "rls_orgs_select" on orgs;
create policy "rls_orgs_select"
  on orgs for select
  using (
    deleted_at is null
    and id in (select org_id from org_members where user_id = auth.uid())
  );

-- 4. `lorekit_org_delete` becomes a SOFT delete: stamp `deleted_at` instead of
--    removing the row. Same owner-only authorization (`delete_org` capability)
--    and `auth.uid()` actor pattern as 00022. Idempotent: a second call on an
--    already-soft-deleted org is a no-op (the `deleted_at is null` guard) and
--    still returns void.
create or replace function lorekit_org_delete(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'delete_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=delete_org', p_org_id);
  end if;

  update orgs set deleted_at = now() where id = p_org_id and deleted_at is null;
end;
$$;

grant execute on function lorekit_org_delete(uuid) to authenticated, service_role;

-- 5. NEW: `lorekit_org_purge` — the real, irreversible cascading delete. Same
--    owner-only gate as delete (there is no separate "purge" capability;
--    permanent removal is the owner's prerogative, identical trust level to
--    soft-delete). The `delete from orgs` cascades to org_members / org_invites
--    / org_limits and nulls/cascades `memories.org_id` per the FK definitions.
--    Not authorization-gated on `deleted_at` — an owner may purge a live org
--    directly (skip the retention window) or purge one already soft-deleted.
--    No app-layer/server-action caller ships this PR: the audit_log action
--    CHECK (00023) has no `org.purge` value, so wiring a dashboard purge button
--    would require a second CHECK migration. Shipped SQL-first as the explicit
--    permanent-delete / grace-period-job entry point; the dashboard delete flow
--    uses the soft-delete above.
create or replace function lorekit_org_purge(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not lorekit_org_can(auth.uid(), p_org_id, 'delete_org') then
    raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s capability=purge', p_org_id);
  end if;

  delete from orgs where id = p_org_id;
end;
$$;

grant execute on function lorekit_org_purge(uuid) to authenticated, service_role;
