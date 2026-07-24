-- LoreKit abuse guardrails: per-user memory cap + request rate limiting.
--
-- Two enforcement planes sharing one config source:
--   * Cap plane (authoritative): enforce_memory_cap() BEFORE INSERT trigger on
--     memories, keyed off NEW.user_id. Counts active (non-archived) rows and
--     rejects the insert once the user's max_memories limit is reached. Upsert
--     updates (existing key) never trip this — only NEW rows go through
--     BEFORE INSERT.
--   * Rate plane (transport): lorekit_check_rate_limit() RPC, a Postgres-backed
--     fixed-window counter. Called by the app layer (Deno edge fn / Node
--     server) right after auth resolves, per request, per user.
--
-- Config source: lorekit_default_limit(key) is the single free-tier default;
-- user_limits holds nullable per-user overrides; lorekit_get_limit resolves
-- COALESCE(override, default). No numeric limit is hardcoded in app code.
--
-- Service-role (NEW.user_id / p_user_id IS NULL — CI/internal) is exempt from
-- both guardrails.

-- 1. Single source of truth for free-tier default limits.
create or replace function lorekit_default_limit(p_key text)
returns integer
language sql
immutable
as $$
  select case p_key
    when 'max_memories'         then 1000
    when 'requests_per_minute'  then 120
    else null
  end;
$$;

-- 2. Per-user override table. Absence of a row (or a null column) means the
--    user is on the free-tier default — lorekit_get_limit() never returns null.
create table if not exists user_limits (
  user_id             uuid primary key references auth.users on delete cascade,
  max_memories        integer,
  requests_per_minute integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table user_limits enable row level security;

-- Users can see their own override row (so the dashboard/CLI can show "your
-- limit"); raising a limit is a service-role/admin upsert for now — no
-- insert/update policy for regular users.
create policy "rls_user_limits_select"
  on user_limits for select
  using (user_id = auth.uid());

create or replace trigger user_limits_updated_at
  before update on user_limits
  for each row execute function set_updated_at();

-- 3. Resolve the effective limit for a user: override if set, else the
--    free-tier default. Security definer so it can read user_limits
--    regardless of the caller's RLS visibility (needed inside the trigger).
create or replace function lorekit_get_limit(p_user_id uuid, p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override integer;
begin
  if p_key = 'max_memories' then
    select max_memories into v_override from user_limits where user_id = p_user_id;
  elsif p_key = 'requests_per_minute' then
    select requests_per_minute into v_override from user_limits where user_id = p_user_id;
  end if;

  return coalesce(v_override, lorekit_default_limit(p_key));
end;
$$;

-- 4. Cap trigger — the authoritative guardrail. Counts NEW.user_id's active
--    (archived_at IS NULL) rows and rejects the insert at/over the limit.
--    Service-role / CI writes (NEW.user_id IS NULL) are exempt.
--    Raises a custom SQLSTATE ('LK001') so the app layer can distinguish this
--    from any other DB error and translate it into an actionable LimitError
--    (see packages/mcp-core/src/limits.ts and supabase/functions/mcp/limits.ts).
create or replace function enforce_memory_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if new.user_id is null then
    return new; -- service-role / CI writes are exempt from the cap
  end if;

  v_limit := lorekit_get_limit(new.user_id, 'max_memories');

  select count(*) into v_count
    from memories
   where user_id = new.user_id
     and archived_at is null;

  if v_count >= v_limit then
    raise exception using
      errcode = 'LK001',
      message = format('memory_cap_exceeded: limit=%s', v_limit);
  end if;

  return new;
end;
$$;

create or replace trigger memories_enforce_cap
  before insert on memories
  for each row execute function enforce_memory_cap();

-- 5. Rate-limit counter table — one tiny row per (user, window). Postgres-
--    backed (not in-memory) because edge isolates are stateless/short-lived.
create table if not exists rate_limit_counters (
  user_id      uuid not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, window_start)
);

create index if not exists rate_limit_counters_window_idx
  on rate_limit_counters (window_start);

alter table rate_limit_counters enable row level security;
-- No policies: this table is a transport-layer implementation detail, only
-- ever touched via the security-definer RPC below (service-role / RPC path).

-- 6. Atomic fixed-window rate-limit check. Increments the current window's
--    counter and returns whether the request is allowed, plus how long until
--    the next window opens (Retry-After).
create or replace function lorekit_check_rate_limit(
  p_user_id        uuid,
  p_window_seconds integer default 60
)
returns table(
  allowed             boolean,
  current_count       integer,
  limit_value         integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_limit        integer;
  v_count        integer;
  v_retry_after  integer;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_limit := lorekit_get_limit(p_user_id, 'requests_per_minute');

  insert into rate_limit_counters (user_id, window_start, count)
  values (p_user_id, v_window_start, 1)
  on conflict (user_id, window_start)
  do update set count = rate_limit_counters.count + 1
  returning rate_limit_counters.count into v_count;

  v_retry_after := ceil(extract(epoch from (v_window_start + (p_window_seconds || ' seconds')::interval - now())))::integer;
  if v_retry_after < 0 then
    v_retry_after := 0;
  end if;

  return query select (v_count <= v_limit), v_count, v_limit, v_retry_after;
end;
$$;
