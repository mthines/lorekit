-- Keyset-pagination covering index for the Lore Explorer's server-side
-- paginated list of memories (ordered newest-first, tiebroken by id).
--
-- Mirrors the pattern established by 00012_audit_log_search.sql for
-- audit_log: the `(user_id, created_at desc, id)` index covers the keyset
-- seek used by `listMemories` (the `(created_at desc, id desc)` order +
-- the `.or()` "after cursor" predicate). The `id` tiebreaker is required so
-- the seek is deterministic when multiple rows share the same `created_at`;
-- 00001's `memories_user_idx (user_id)` lacks both `created_at` and `id`.
--
-- Also enables pg_trgm trigram search on `memories.key` and `memories.value`
-- for the key/value substring search (`ilike '%…%'`), mirroring the
-- 00012_audit_log_search.sql precedent for `audit_log.target`.
create extension if not exists pg_trgm;

create index if not exists memories_user_created_at_id_idx
  on memories (user_id, created_at desc, id desc);

create index if not exists memories_key_trgm_idx
  on memories using gin (key gin_trgm_ops);

create index if not exists memories_value_trgm_idx
  on memories using gin (value gin_trgm_ops);
