-- Org write foundations, part 2: a tenant-keyed memory cap.
--
-- `org_limits` + `lorekit_get_org_limit` mirror `user_limits` +
-- `lorekit_get_limit` (00004_limits.sql) exactly — a nullable per-org
-- override table, COALESCEd against the same free-tier default via
-- `lorekit_default_limit`, so raising an org's cap is a single row upsert
-- (paid-tier-ready, no billing built yet). Only `max_memories` is carried —
-- rate limiting stays caller-keyed this phase (see plan.md Decisions), so an
-- org `requests_per_minute` column would be dead configuration.
--
-- `enforce_memory_cap()` gains an org branch that MUST run BEFORE the
-- `user_id IS NULL` service exemption: an org-owned row always has
-- `user_id IS NULL` (00013/00014), so without this ordering an org write
-- would silently inherit the cap-exempt service partition. Branch order is
-- now org -> service-exempt -> personal.

create table if not exists org_limits (
  org_id       uuid primary key references orgs(id) on delete cascade,
  max_memories integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table org_limits enable row level security;

-- Members can see their org's limit row (dashboard/CLI "your org's limit");
-- raising a limit is a service-role/admin upsert for now — no insert/update
-- policy for regular members, mirroring user_limits' shape.
create policy "rls_org_limits_select"
  on org_limits for select
  using (
    org_id in (select lorekit_member_org_ids(auth.uid()))
  );

create or replace trigger org_limits_updated_at
  before update on org_limits
  for each row execute function set_updated_at();

-- Resolve the effective limit for an org: override if set, else the same
-- free-tier default lorekit_get_limit uses. Security definer so it can read
-- org_limits regardless of the caller's RLS visibility (needed inside the
-- cap trigger).
create or replace function lorekit_get_org_limit(p_org_id uuid, p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override integer;
begin
  if p_key = 'max_memories' then
    select max_memories into v_override from org_limits where org_id = p_org_id;
  end if;

  return coalesce(v_override, lorekit_default_limit(p_key));
end;
$$;

grant execute on function lorekit_get_org_limit(uuid, text) to anon, authenticated, service_role;

-- Index backing the org branch's active-row count below
-- (`where org_id = new.org_id and archived_at is null`), which runs on every
-- org-owned INSERT. Without it large orgs seq-scan `memories` per write.
-- Partial (archived_at is null) + org_id-keyed to match the count predicate.
create index if not exists memories_org_id_active_idx
  on memories (org_id)
  where archived_at is null;

-- Tenant-keyed cap trigger. Branch order: org -> service-exempt -> personal.
-- The org branch must precede the service exemption because org rows have
-- user_id IS NULL — checking `new.user_id is null` first would silently
-- exempt every org write from any cap at all.
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
  if new.org_id is not null then
    v_limit := lorekit_get_org_limit(new.org_id, 'max_memories');

    select count(*) into v_count
      from memories
     where org_id = new.org_id
       and archived_at is null;

    if v_count >= v_limit then
      raise exception using
        errcode = 'LK001',
        message = format('memory_cap_exceeded: limit=%s', v_limit);
    end if;

    return new;
  end if;

  if new.user_id is null then
    return new; -- true service-role / CI exemption (both org_id and user_id null)
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
