-- LoreKit billing plans — Phase 1 (free plan only).
--
-- Introduces a `plan` concept without any billing integration:
--   * `user_plans` table tracks which plan a user is on (default: 'free').
--   * `lorekit_default_limit` is updated so plan-aware defaults can be read
--     from the table — a future paid tier only needs to insert a row here.
--   * The free-plan `max_memories` default rises from 1000 → 5000.
--   * A `plan_name` column is added to `user_limits` so any manual override
--     row can be annotated with its originating plan (audit trail).
--
-- Security posture:
--   * Users can read their own plan row (dashboard "you are on the free plan").
--   * Only service-role / admin can insert or update plan rows (no self-upgrade).
--   * RLS on `user_plans` mirrors `user_limits` exactly.
--
-- Existing `user_limits` per-user overrides continue to take precedence over
-- the plan default via the existing `COALESCE(override, default)` chain in
-- `lorekit_get_limit` — no change needed there. Raising a user's cap beyond
-- their plan ceiling remains a service-role upsert into `user_limits`.

-- 1. Plan definitions table — the authoritative per-plan limit defaults.
--    Adding a new plan in future is a single INSERT here.
create table if not exists plans (
  name             text primary key,           -- e.g. 'free', 'pro', 'team'
  max_memories     integer not null,
  requests_per_minute integer not null,
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Trigger to keep updated_at current on plan changes.
create or replace trigger plans_updated_at
  before update on plans
  for each row execute function set_updated_at();

-- Anyone can read plan definitions (they are public limits, not PII).
alter table plans enable row level security;
create policy "rls_plans_select"
  on plans for select
  using (true);

-- Seed the free plan. ON CONFLICT so the migration is idempotent on re-runs.
insert into plans (name, max_memories, requests_per_minute, description)
values (
  'free',
  5000,
  120,
  'Free plan: up to 5000 stored memories, 120 requests per minute.'
)
on conflict (name) do update
  set max_memories        = excluded.max_memories,
      requests_per_minute = excluded.requests_per_minute,
      description         = excluded.description,
      updated_at          = now();

-- 2. Per-user plan assignment. Absence of a row means the user is on 'free'.
create table if not exists user_plans (
  user_id    uuid primary key references auth.users on delete cascade,
  plan_name  text not null default 'free' references plans(name),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_plans enable row level security;

-- Users can read their own plan row.
create policy "rls_user_plans_select"
  on user_plans for select
  using (user_id = auth.uid());

create or replace trigger user_plans_updated_at
  before update on user_plans
  for each row execute function set_updated_at();

-- 3. Annotate user_limits with the plan that originated the override (optional,
--    for audit/analytics). Nullable so existing rows are unaffected.
alter table user_limits
  add column if not exists plan_name text references plans(name);

-- 4. Update lorekit_default_limit to read from the `plans` table when a
--    matching row exists, falling back to hard-coded values for safety.
--    The user-plan lookup goes through lorekit_get_limit (below) so this
--    function stays plan-agnostic — it is only the universal fallback.
create or replace function lorekit_default_limit(p_key text)
returns integer
language sql
stable   -- changed from immutable: now reads the plans table
security definer
set search_path = public
as $$
  select case p_key
    when 'max_memories'        then (select max_memories        from plans where name = 'free')
    when 'requests_per_minute' then (select requests_per_minute from plans where name = 'free')
    else null
  end;
$$;

-- 5. Plan-aware limit resolver. Replaces lorekit_get_limit with a version that
--    reads the user's plan first, then falls back to the per-user override,
--    then to the plan default. The precedence chain is:
--      user_limits override > plan default > lorekit_default_limit (free).
--
--    This ensures a pro-plan user gets their plan ceiling even without an
--    explicit user_limits row, while a user_limits override still wins
--    (needed when an admin manually caps a misbehaving user below their plan).
create or replace function lorekit_get_limit(p_user_id uuid, p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override    integer;
  v_plan_name   text;
  v_plan_limit  integer;
begin
  -- Step 1: per-user manual override (highest precedence).
  if p_key = 'max_memories' then
    select max_memories into v_override from user_limits where user_id = p_user_id;
  elsif p_key = 'requests_per_minute' then
    select requests_per_minute into v_override from user_limits where user_id = p_user_id;
  end if;
  if v_override is not null then
    return v_override;
  end if;

  -- Step 2: plan-based limit (falls back to 'free' when no row exists).
  select coalesce(up.plan_name, 'free')
    into v_plan_name
    from user_plans up
   where up.user_id = p_user_id;

  if v_plan_name is null then
    v_plan_name := 'free';
  end if;

  if p_key = 'max_memories' then
    select max_memories into v_plan_limit from plans where name = v_plan_name;
  elsif p_key = 'requests_per_minute' then
    select requests_per_minute into v_plan_limit from plans where name = v_plan_name;
  end if;

  -- Step 3: ultimate fallback (handles unknown keys gracefully).
  return coalesce(v_plan_limit, lorekit_default_limit(p_key));
end;
$$;

-- Grant read on new tables so authenticated + anon selects work under RLS.
grant select on table plans to anon, authenticated, service_role;
grant select on table user_plans to anon, authenticated, service_role;
grant insert, update on table user_plans to service_role;
grant insert, update on table user_limits to service_role;
