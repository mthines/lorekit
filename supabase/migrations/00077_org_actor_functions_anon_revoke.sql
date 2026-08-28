-- Close residual `anon` EXECUTE grants left over on seven functions whose
-- migrations only ever revoked PUBLIC, not `anon` by name.
--
-- ── The problem ──────────────────────────────────────────────────────────
-- Every migration below follows the schema's standard pattern of running
-- `revoke execute on function ... from public;` before granting to
-- `authenticated, service_role` — intended to strip PostgreSQL's default
-- PUBLIC EXECUTE grant on a newly CREATEd function.
--
-- That pattern assumes `anon`'s only path to EXECUTE is inheriting the
-- PUBLIC grant. On this project's Supabase Postgres image, a newly CREATEd
-- function in `public` also picks up a *direct* `ALTER DEFAULT PRIVILEGES`
-- grant to `anon` (separate from, and not touched by, `revoke ... from
-- public`) — the same class of gap 00046 already had to close for
-- `memory_delete` with an explicit `revoke ... from public, anon`. Wherever
-- a later migration also named `anon` explicitly, the gap was already
-- closed (e.g. `restore_memory` in 00072, `memory_delete` itself in 00069/
-- 00071, the 00047 read-function hardening, `lorekit_db_query_stats` in
-- 00074). The seven below never got that explicit `anon` revoke, so a fresh
-- CREATE (00041) or a CREATE OR REPLACE that only re-asserted the PUBLIC
-- revoke (00046/00062) left the default-privilege grant to `anon` intact:
--
--   * `lorekit_org_actor(uuid)` (00041) — resolves the acting user for
--     every org RPC.
--   * `lorekit_org_members_list(uuid, uuid)` (00041) — returns other org
--     members' GitHub handles and avatars (PII), gated on membership in the
--     function body — a gate that only matters if the function can be
--     reached in the first place.
--   * `archive_memory(uuid, text, text)`, `purge_archived_memories(uuid,
--     integer)`, `purge_expired_memories(uuid)` (00003/00030, re-asserted by
--     00046) — the same caller-supplied-`p_user_id` RPCs 00046's own header
--     names as needing this treatment; only `memory_delete` was named
--     against `anon` there, the other three were not.
--   * `lorekit_usage_stats(uuid, timestamptz, timestamptz, text)` (00043,
--     re-created by 00044) — a bare `p_user_id` reader; anon EXECUTE would
--     expose any user's usage aggregates.
--   * `lorekit_memory_set_embedding(uuid, uuid, text, text)` (00062).
--
-- `supabase/tests/migrations.test.sql` already asserts every one of these
-- must not be executable by `anon`; this migration is the fix those
-- assertions caught.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- Revoke EXECUTE from `anon` by name, matching 00046's precedent for
-- `memory_delete`. `public` is included too so this is idempotent
-- regardless of which grant path is present in a given environment;
-- `authenticated, service_role` are unaffected.

revoke execute on function lorekit_org_actor(uuid) from public, anon;
revoke execute on function lorekit_org_members_list(uuid, uuid) from public, anon;
revoke execute on function archive_memory(uuid, text, text) from public, anon;
revoke execute on function purge_archived_memories(uuid, integer) from public, anon;
revoke execute on function purge_expired_memories(uuid) from public, anon;
revoke execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text) from public, anon;
revoke execute on function lorekit_memory_set_embedding(uuid, uuid, text, text) from public, anon;
