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

comment on function purge_archived_memories(uuid, integer) is
  'Hard-deletes the CALLER''s archived rows past the retention window. The
   effective user id is resolved by the same service-role-gated rule as
   lorekit_org_actor (00041): a caller-supplied p_user_id is honoured only on
   a verified service-role connection and is otherwise ignored in favour of
   auth.uid(). Fails closed on a NULL actor.';
