-- Make org ownership a first-class partition of the (scope, key) uniqueness
-- arbiter, and re-pin memory_write's ON CONFLICT predicates to match.
--
-- 00003 introduced two partial unique indexes:
--   memories_user_scope_key_active_unique      (user_id, scope, key)
--     WHERE archived_at IS NULL
--   memories_null_user_scope_key_active_unique  (scope, key)
--     WHERE user_id IS NULL AND archived_at IS NULL
--
-- Now that org_id is a real FK (00013), those two predicates are ambiguous
-- for an org-owned row (org_id IS NOT NULL, user_id may be NULL or set to the
-- creator) — it could collide with either partition. This migration replaces
-- them with THREE mutually-exclusive partial unique indexes:
--   • org-owned  (org_id, scope, key)  WHERE org_id IS NOT NULL AND archived_at IS NULL
--   • personal   (user_id, scope, key) WHERE org_id IS NULL AND user_id IS NOT NULL AND archived_at IS NULL
--   • service    (scope, key)          WHERE org_id IS NULL AND user_id IS NULL AND archived_at IS NULL
-- An org row can never collide with (or impersonate) the cap-exempt
-- user_id IS NULL service partition, because the org index requires
-- org_id IS NOT NULL while the service index requires org_id IS NULL.
--
-- Postgres' ON CONFLICT arbiter inference requires the inference clause's
-- predicate to match the target partial index's predicate, so memory_write's
-- two ON CONFLICT ... WHERE clauses must be re-pinned in the same migration
-- or every write breaks. No signature change (still no p_org_id parameter —
-- writes stay personal-only, Requirement R7), so CREATE OR REPLACE suffices
-- (matches the "same drop+recreate shape only when the signature/return
-- changes" note in 00009/00011 — here only the body changes).

drop index if exists memories_user_scope_key_active_unique;
drop index if exists memories_null_user_scope_key_active_unique;

create unique index if not exists memories_user_scope_key_active_unique
  on memories (user_id, scope, key)
  where org_id is null and user_id is not null and archived_at is null;

create unique index if not exists memories_null_user_scope_key_active_unique
  on memories (scope, key)
  where org_id is null and user_id is null and archived_at is null;

create unique index if not exists memories_org_scope_key_active_unique
  on memories (org_id, scope, key)
  where org_id is not null and archived_at is null;

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null
)
returns table (id uuid, created_at timestamptz, inserted boolean)
language plpgsql
set search_path = public
as $$
begin
  if p_user_id is null then
    -- service-role / CI writes: (scope, key) partial index for
    -- org_id IS NULL AND user_id IS NULL.
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at)
    values (null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()))
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted;
  else
    -- user-scoped writes (api_key / user): (user_id, scope, key) partial
    -- index for org_id IS NULL AND user_id IS NOT NULL. Phase 1 never sets
    -- org_id on a write, so every insert lands in this personal partition.
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at)
    values (p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()))
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz)
  to anon, authenticated, service_role;
