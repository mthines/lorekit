-- ═════════════════════════════════════════════════════════════════════════
-- Memory RPC actor guard — close a caller-supplied-user-id access-control gap.
--
-- ── The problem ──────────────────────────────────────────────────────────
-- Four SECURITY DEFINER RPCs act on a caller-supplied `p_user_id` with no
-- comparison against the authenticated caller:
--
--   archive_memory(p_user_id, scope, key)            — 00003
--   restore_memory(p_user_id, scope, key)            — 00003
--   purge_archived_memories(p_user_id, retention)    — 00003  (hard DELETE)
--   purge_expired_memories(p_user_id)                — 00030  (hard DELETE)
--
-- SECURITY DEFINER runs the body as the table owner, and no migration sets
-- FORCE ROW LEVEL SECURITY on `memories`, so the owner BYPASSES the `rls_read`
-- update/select policies entirely. The row that is touched is chosen solely by
-- the `where user_id = p_user_id` predicate — a value the caller supplies.
-- The 00003 comment ("Uses SECURITY DEFINER so the RLS update policy
-- (user_id = auth.uid()) still applies") has the mechanism backwards: DEFINER
-- is precisely the construct that stops that policy applying.
--
-- Worse, three of the four keep PostgreSQL's default `EXECUTE` grant to
-- PUBLIC (00003 never revoked it; only the org RPCs got that treatment in
-- 00041). purge_expired_memories added a grant to `authenticated` but never
-- revoked PUBLIC either, so its "intentionally excludes anon" comment did not
-- hold. Supabase exposes public-schema functions over PostgREST, so as
-- deployed any caller could:
--
--   POST /rest/v1/rpc/purge_archived_memories
--        { "p_user_id": "<victim-uuid>", "p_retention_days": 0 }
--
-- and hard-delete another user's archived rows — a textbook broken-access-
-- control (OWASP A01) IDOR. The application layer is careful everywhere
-- (the dashboard resolves user.id from the session; the MCP purge tool
-- refuses without a resolved user id) so the product path is sound; the gap
-- is at the grant boundary, which the app layer cannot close.
--
-- ── The fix, and why it is the precedent already in this repo ────────────
-- 00041_org_actor_override.sql solved the identical problem for the org
-- RPCs: resolve the actor so that a caller-supplied id is honoured ONLY on a
-- verified service-role connection and is otherwise ignored in favour of
-- `auth.uid()`. This migration applies the same rule to the four memory RPCs.
--
--     effective actor =
--       auth.role() = 'service_role'  ->  coalesce(p_user_id, auth.uid())
--       otherwise                     ->  auth.uid()
--
-- ── THE SECURITY INVARIANT (identical to lorekit_org_actor) ──────────────
-- 1. AN `authenticated` CALLER'S `p_user_id` IS IGNORED, ENTIRELY. The `else`
--    branch returns `auth.uid()` and nothing else, so a dashboard user (or
--    anyone with an anon-key + user JWT hitting PostgREST directly) can name
--    any UUID and still only ever acts on their OWN rows. No request input
--    changes this, because the discriminator is not request input.
-- 2. THE DISCRIMINATOR IS A VERIFIED JWT CLAIM, NOT A REQUEST FIELD.
--    `auth.role()` reads the `role` claim PostgREST sets from the JWT it has
--    already cryptographically verified. Forging it requires the signing
--    secret. This is the same predicate `rls_insert` (00001) and
--    `lorekit_org_actor` (00041) already rely on.
-- 3. WHO HOLDS SERVICE-ROLE: only `SUPABASE_SERVICE_ROLE_KEY`, held in
--    server-side secrets (edge functions, CI). The edge/MCP path does not take
--    the actor from the request body — it resolves it from the `api_tokens`
--    row it authenticated by hash — so the chain is "presented token ->
--    hashed -> matched row -> that row's owner", never "caller said so".
-- 4. IT FAILS CLOSED. When the actor resolves to NULL (service-role, no
--    override, no `sub`), `where user_id = NULL` matches no row, so the
--    UPDATE/DELETE touches nothing.
-- 5. IT IS BEHAVIOUR-PRESERVING FOR LEGITIMATE CALLERS. The signatures are
--    unchanged (plain `create or replace`, no new overload). The dashboard
--    already passes user.id == auth.uid(), so resolving to auth.uid() is a
--    no-op for it; the edge/MCP service-role path already passes the resolved
--    token owner, which the service-role branch honours via coalesce.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. archive_memory — soft-archive the CALLER's own row.
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
  v_id    uuid;
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  update memories
     set archived_at = now()
   where user_id = v_actor
     and scope    = p_scope
     and key      = p_key
     and archived_at is null
  returning id into v_id;

  return v_id; -- null if row not found or already archived
end;
$$;

-- 2. restore_memory — clear archived_at on the CALLER's own row.
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
  v_id    uuid;
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  update memories
     set archived_at = null
   where user_id = v_actor
     and scope    = p_scope
     and key      = p_key
     and archived_at is not null
  returning id into v_id;

  return v_id;
end;
$$;

-- 3. purge_archived_memories — hard-delete the CALLER's own archived rows.
create or replace function purge_archived_memories(
  p_user_id        uuid,
  p_retention_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  delete from memories
   where user_id     = v_actor
     and archived_at is not null
     and archived_at < now() - (p_retention_days * interval '1 day')
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 4. purge_expired_memories — hard-delete the CALLER's own expired rows.
create or replace function purge_expired_memories(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  delete from memories
   where user_id     = v_actor
     and expires_at  is not null
     and expires_at  < now()
     and archived_at is null   -- archived rows stay with purge_archived_memories
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────
-- `create or replace` preserves the pre-existing grants, so revoke the
-- default PUBLIC EXECUTE explicitly (00003 never did) and re-issue least-
-- privilege grants, matching the posture 00041 established for the org RPCs.
-- Now that the actor guard makes a caller-supplied id inert for anyone but a
-- service-role connection, these are safe to keep on `authenticated`.
revoke execute on function archive_memory(uuid, text, text)             from public;
revoke execute on function restore_memory(uuid, text, text)             from public;
revoke execute on function purge_archived_memories(uuid, integer)       from public;
revoke execute on function purge_expired_memories(uuid)                 from public;

grant execute on function archive_memory(uuid, text, text)             to authenticated, service_role;
grant execute on function restore_memory(uuid, text, text)             to authenticated, service_role;
grant execute on function purge_archived_memories(uuid, integer)       to authenticated, service_role;
grant execute on function purge_expired_memories(uuid)                 to authenticated, service_role;

-- Correct the record on all four functions. 00003's file comment above
-- archive_memory claimed "Uses SECURITY DEFINER so the RLS update policy
-- (user_id = auth.uid()) still applies" — backwards: DEFINER runs as the table
-- owner and, absent FORCE ROW LEVEL SECURITY, BYPASSES that policy. What
-- actually scopes each of these is the resolved actor below, not RLS. A
-- `comment on function` is the durable place to say so (a comment on a
-- superseded body in 00003 can't be edited forward-only).
comment on function archive_memory(uuid, text, text) is
  'Soft-archives the effective caller''s own row. SECURITY DEFINER BYPASSES the
   memories RLS policies (no FORCE ROW LEVEL SECURITY), so the row is scoped by
   the resolved actor, NOT by RLS — correcting 00003''s backwards note. The
   actor is resolved by the same service-role-gated rule as lorekit_org_actor
   (00041): a caller-supplied p_user_id is honoured only on a verified
   service-role connection, otherwise auth.uid() wins. Fails closed on NULL.';
comment on function restore_memory(uuid, text, text) is
  'Restores the effective caller''s own archived row. Same actor rule and same
   RLS-bypass caveat as archive_memory (see 00043 header; corrects 00003).';
comment on function purge_archived_memories(uuid, integer) is
  'Hard-deletes the effective caller''s archived rows past the retention window.
   The effective user id is resolved by the same service-role-gated rule as
   lorekit_org_actor (00041): a caller-supplied p_user_id is honoured only on a
   verified service-role connection and is otherwise ignored in favour of
   auth.uid(). SECURITY DEFINER bypasses RLS; the actor scopes the delete.
   Fails closed on a NULL actor.';
comment on function purge_expired_memories(uuid) is
  'Hard-deletes the effective caller''s expired (non-archived) rows. Same
   service-role-gated actor rule and RLS-bypass caveat as
   purge_archived_memories (see 00043 header).';

-- ═════════════════════════════════════════════════════════════════════════
-- 5. memory_delete — the omitted fifth RPC of this family.
--
-- 00020's memory_delete has the SAME caller-supplied-p_user_id flaw as the
-- four above, and it is the most dangerous: SECURITY DEFINER, granted to
-- `anon`, and it hard-DELETEs (p_force=true) or archives on a bare
-- `where user_id = p_user_id` with no auth.uid()/service-role gate. Over
-- PostgREST that is an anon-reachable, cross-tenant DESTRUCTIVE IDOR:
--   POST /rest/v1/rpc/memory_delete
--        { "p_user_id":"<victim>", "p_scope":"global", "p_key":"k", "p_force":true }
-- The org branch is exploitable too — it gates on
-- lorekit_org_can(p_user_id, ...) with the CALLER's p_user_id, so naming any
-- privileged member deletes that org's lore as a non-member. It was simply
-- omitted from this migration's original list; recreate it with the identical
-- actor guard, applied to BOTH the personal user_id filter AND the org
-- capability check, so the org path authorizes the REAL caller, never a named
-- member. Behaviour-preserving: the edge api_key path (service-role) still
-- names the token owner via coalesce; a JWT caller resolves to its own
-- auth.uid() (which the edge already passes as p_user_id).
create or replace function memory_delete(
  p_user_id  uuid,
  p_org_slug text default null,
  p_scope    text default null,
  p_key      text default null,
  p_force    boolean default false
)
returns table (deleted boolean, archived boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_count  integer;
  v_actor  uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug;
    if v_org_id is null then
      raise exception using
        errcode = 'P0001',
        message = format('unknown_org: %s', p_org_slug);
    end if;

    if p_force then
      if not lorekit_org_can(v_actor, v_org_id, 'hard_delete') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=hard_delete', p_org_slug);
      end if;

      delete from memories
       where org_id = v_org_id and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      if not lorekit_org_can(v_actor, v_org_id, 'archive') then
        raise exception using
          errcode = 'LK002',
          message = format('org_permission_denied: org=%s capability=archive', p_org_slug);
      end if;

      update memories
         set archived_at = now()
       where org_id = v_org_id and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0);
    end if;
  else
    -- Personal delete: scoped to the RESOLVED actor, never a named p_user_id.
    if p_force then
      delete from memories
       where user_id = v_actor and scope = p_scope and key = p_key;
      get diagnostics v_count = row_count;

      return query select (v_count > 0), false;
    else
      update memories
         set archived_at = now()
       where user_id = v_actor and scope = p_scope and key = p_key and archived_at is null;
      get diagnostics v_count = row_count;

      return query select false, (v_count > 0);
    end if;
  end if;
end;
$$;

-- 00020:92 granted memory_delete to `anon` EXPLICITLY (unlike the 00003/00030
-- RPCs, which only had the default PUBLIC grant). `revoke ... from public` does
-- NOT remove a per-role grant, so anon must be revoked by name too — otherwise
-- anon keeps EXECUTE (the actor guard makes the call inert, but least-privilege
-- means removing the grant, not just relying on the guard).
revoke execute on function memory_delete(uuid, text, text, text, boolean) from public, anon;
grant execute on function memory_delete(uuid, text, text, text, boolean) to authenticated, service_role;

comment on function memory_delete(uuid, text, text, text, boolean) is
  'Archives (p_force=false) or hard-deletes (p_force=true) the effective
   caller''s own memory, or an org''s memory when p_org_slug is given and the
   caller has the archive/hard_delete capability. The effective actor is
   resolved by the same service-role-gated rule as the rest of this family
   (00043) and lorekit_org_actor (00041): a caller-supplied p_user_id is
   honoured only on a verified service-role connection, otherwise auth.uid()
   wins — scoping BOTH the personal user_id filter and the org capability
   check to the real caller. SECURITY DEFINER bypasses RLS; the actor is the
   gate. Fails closed on a NULL actor.';
