---
for: pr-reviewer
lens-version: 1
applies-to: "supabase/migrations/*.sql"
---

# Migration query performance — Review Lens

## Trigger

Any added or changed `supabase/migrations/*.sql` that creates or replaces an index, policy, view, trigger, or an RPC the edge functions call per request.

## Checklist

- [ ] Every new or changed predicate and `order by` in an RPC or view is served by an index whose leading columns match it (`user_id` or the tenant key first), and the header comment names that index; production already cancelled `/memories/read-activity` for exactly this (00109).
- [ ] A new index names the query it serves and carries a `comment on index`; on `usage_events` and `memories` it also accepts the per-write cost, and it is not a prefix of an index that already exists.
- [ ] A partial-index predicate is immutable (no `now()` or `current_*`), and the query it serves restates that predicate verbatim, or the planner will not use the index.
- [ ] No function wraps an indexed column in a `where` (`date(created_at)`, `lower(col)`) unless a matching expression index is added; `ilike '%x%'` and array containment have a `pg_trgm` or GIN index.
- [ ] A vector index is HNSW, never IVFFlat on a table that already holds rows, and the column stays at or under 2000 dimensions (00060).
- [ ] A foreign-key column has an index on the referencing side, or the cascade it triggers (org deletion) is shown to touch few rows.
- [ ] A new RLS policy wraps `auth.uid()` and `auth.role()` as `(select auth.uid())` so the planner evaluates them once, and tenant visibility reuses `lorekit_member_org_ids()` instead of a per-row subquery.
- [ ] A read-only function is marked `stable` (or `immutable` only when it truly is); a bare default-volatile read RPC blocks planner optimisations.
- [ ] A list or aggregate RPC is bounded: a `limit` plus keyset paging on `(sort key, id)`, never `offset`, and its count describes the same rows its list returns.
- [ ] No row-by-row loop in plpgsql that runs one query per iteration; the work is a set-based statement.

## Severity hints

- **Must-fix**: a new predicate no index can serve, an unbounded list RPC, IVFFlat on a populated table, a volatile function in a partial-index predicate.
- **Should-fix**: missing `comment on index`, bare `auth.uid()` in a NEW policy, missing `stable`, a redundant index.
- **Nice-to-have**: legacy policies that use bare `auth.uid()` and are untouched by the diff.
