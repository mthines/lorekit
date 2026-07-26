-- Keyset pagination + name search support for the Settings → Audit Logs feed
-- (see packages/web/src/lib/pagination/ and the extended listAuditLog in
-- packages/web/src/lib/audit-log.ts). Forward-only, additive: no existing
-- column, constraint, or RLS policy is touched.
--
-- 1. `pg_trgm` + a GIN trigram index on `audit_log.target` so the
--    case-insensitive substring `name` search (`.ilike('target', '%…%')`)
--    stays index-backed instead of a sequential scan as the table grows.
--    A plain btree index can't serve a leading-wildcard ILIKE; trigram GIN
--    is the standard Postgres answer (mirrors the `memories_fts_idx` GIN
--    index pattern in 00001_memories.sql for full-text search).
--
-- 2. A `(user_id, created_at desc, id)` index covering the keyset seek.
--    00010's `audit_log_user_created_idx (user_id, created_at desc)` serves
--    the ORDER BY but doesn't include `id`, so the keyset predicate's
--    tiebreaker (`created_at.eq.<c>,and(id.lt.<id>)`) can't be resolved from
--    that index alone. Adding `id` makes the whole keyset seek index-only.

create extension if not exists pg_trgm;

create index if not exists audit_log_target_trgm_idx
  on audit_log using gin (target gin_trgm_ops);

create index if not exists audit_log_user_created_id_idx
  on audit_log (user_id, created_at desc, id);
