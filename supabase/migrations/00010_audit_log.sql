-- LoreKit audit log — append-only trail for security/data-affecting actions.
--
-- CAPTURE MODEL: app-layer, explicit (Decision D1). Every audit row is
-- written by application code right after the primary operation succeeds
-- (packages/mcp-core/src/audit.ts + supabase/functions/mcp/audit.ts on the
-- MCP side, packages/web/src/lib/audit-log.ts on the dashboard side) — NOT by
-- a DB trigger on the data tables (memories / api_tokens / webhook_secrets).
-- App-layer capture can see the resolved actor (auth.uid() for dashboard
-- actions, the resolved token/user for MCP, null for service-role/CI) and can
-- shape a human-readable `target` + `metadata`, which a trigger on those
-- tables cannot do cleanly.
--
-- THE ONE DELIBERATE EXCEPTION: `user_limits` changes (Decision D2). No
-- app-layer path writes that table today (raising a user's limit is a raw
-- SQL upsert — see docs/limits.md), so there is no call site to instrument.
-- An AFTER INSERT OR UPDATE OR DELETE trigger (audit_user_limits(), below)
-- is the only way to capture it, mirroring the enforce_memory_cap()
-- DB-trigger precedent from 00004_limits.sql (the write-path actor is not
-- app-visible there either). If an admin server action is ever added for
-- `user_limits`, instrument it there too — the trigger is a safety net, not
-- a reason to skip app-layer capture when a call site exists.
--
-- RLS (Decision D5): append-only. Users may SELECT only their own rows.
-- A scoped INSERT policy permits the authenticated server-action client
-- (mirrors api_tokens' insert policy). NO update/delete policy — once
-- written, a row cannot be changed or removed via the API surface (only a
-- service-role/admin operating directly on the DB could, which is outside
-- RLS's scope by design).

create table if not exists audit_log (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable: service-role/CI writes (memory.* via a service-role token) and
  -- JWT-authenticated MCP calls (see supabase/functions/mcp/audit.ts doc
  -- comment) don't attribute to a resolvable app user_id; RLS SELECT then
  -- never surfaces those rows to any user, mirroring the memory-cap exemption.
  user_id       uuid references auth.users on delete cascade,
  action        text not null check (action in (
    'api_key.create',
    'api_key.revoke',
    'webhook_secret.create',
    'webhook_secret.rotate',
    'webhook_secret.deactivate',
    'memory.create',
    'memory.update',
    'memory.archive',
    'memory.restore',
    'memory.delete',
    'limit.override'
  )),
  resource_type text,
  resource_id   text,
  target        text,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

-- Primary read pattern: "my recent activity", newest first.
create index if not exists audit_log_user_created_idx on audit_log (user_id, created_at desc);

-- Secondary pattern: filter by action type (the Settings → Audit Logs filter pills).
create index if not exists audit_log_action_idx on audit_log (action);

alter table audit_log enable row level security;

-- Users can see only their own audit trail.
create policy "rls_audit_log_select"
  on audit_log for select
  using (user_id = auth.uid());

-- Scoped insert for the authenticated server-action client (mirrors
-- api_tokens' insert policy exactly). Service-role writes (MCP memory
-- mutations) bypass RLS entirely, as usual.
create policy "rls_audit_log_insert"
  on audit_log for insert
  with check (user_id = auth.uid());

-- Deliberately NO update or delete policy — the log is append-only /
-- immutable via the API surface (Decision D5).

-- ── user_limits audit trigger (Decision D2 — the one exception) ────────────
--
-- Fires on every insert/update/delete against user_limits (i.e. every limit
-- override) and records a `limit.override` row. SECURITY DEFINER so it can
-- write audit_log regardless of the caller's RLS visibility, matching
-- enforce_memory_cap()'s shape in 00004_limits.sql. The acting user_id is not
-- known to this trigger (overrides are applied via raw SQL / a future admin
-- path, not a session-scoped request) — recorded as NULL, same as any other
-- service-role-attributed write.
create or replace function audit_user_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_user_id uuid;
  v_metadata    jsonb;
begin
  v_row_user_id := coalesce(new.user_id, old.user_id);

  v_metadata := jsonb_build_object(
    'op', tg_op,
    'max_memories', case when tg_op = 'DELETE' then old.max_memories else new.max_memories end,
    'requests_per_minute', case when tg_op = 'DELETE' then old.requests_per_minute else new.requests_per_minute end
  );

  -- user_limits is keyed by user_id (it IS the row's primary key), so the row
  -- identity (resource_id) and the affected subject (target) are intentionally
  -- the same value here — not a copy-paste. The actual changed limit values
  -- live in metadata, not target.
  insert into audit_log (user_id, action, resource_type, resource_id, target, metadata)
  values (null, 'limit.override', 'user_limits', v_row_user_id::text, v_row_user_id::text, v_metadata);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace trigger user_limits_audit
  after insert or update or delete on user_limits
  for each row execute function audit_user_limits();
