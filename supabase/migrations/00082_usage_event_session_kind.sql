-- ═════════════════════════════════════════════════════════════════════════
-- usage_events.session_kind — WAS this read in a local session, CI, or a PR
-- automation?
--
-- THE GAP: `correlation_id` (00044) is bounded, indexed, filterable, and its
-- own code comment names the intended values ("a PR ref, a branch, a session
-- id") -- but it was populated ONLY when a human hand-exported
-- LOREKIT_CORRELATION_ID. Nothing derived it: there was not one reference to
-- GITHUB_RUN_ID or GITHUB_ACTIONS anywhere in packages/cli, packages/mcp-core,
-- supabase, or plugins outside a Vitest reporter config. So "was this lore
-- read in a local session, a PR automation, or a CI job" was designed for
-- and unanswerable.
--
-- THE FIX has two halves, and this migration is the DB half:
--
--   1. `session_kind` -- bounded, closed to local|ci|pr|unknown, the SAME
--      client/scope_type CHECK pattern (migration 00054): bound in app code,
--      a length CHECK on the column as a backstop, never a CHECK enumerating
--      members. This is the column every chart groups on; correlation_id
--      stays the unbounded drill-down key.
--   2. Recording sites (`_shared/api/router.ts`, `mcp/mcp-handler.ts`) read a
--      NEW `X-LoreKit-Session-Kind` header the CLI now derives and sends
--      (see `packages/cli/src/shared/mcp.mjs`'s `deriveSessionContext` and
--      the shared hook engine) -- the edge never derives, it only validates,
--      the same posture `X-LoreKit-Client` already has.
--
-- Forward-only and additive: the column is nullable, the writer's new
-- parameter is trailing + defaulted, so every existing row and caller is
-- unaffected. Retroactive for NEW traffic only.
-- ═════════════════════════════════════════════════════════════════════════

alter table usage_events add column if not exists session_kind text;

-- Bound as a BACKSTOP, matching 00054's `usage_events_client_len` exactly:
-- the primary gate is the app-side `parseSessionKind`, this only stops a
-- direct insert from putting an unbounded value into a grouped column.
alter table usage_events drop constraint if exists usage_events_session_kind_len;
alter table usage_events add constraint usage_events_session_kind_len
  check (session_kind is null or (char_length(session_kind) between 1 and 16));

-- ── writer: add a trailing p_session_kind ────────────────────────────────
-- DROP first: a new parameter changes the signature. The dropped signature is
-- 00076's fifteen-argument one (…, p_scope, p_scope_count) -- a stale drop
-- target is silent, leaving two overloads live and every named-argument call
-- ambiguous.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text, integer);

create or replace function lorekit_record_usage_event(
  p_user_id        uuid    default null,
  p_org_id         uuid    default null,
  p_plan_name      text    default null,
  p_tool_name      text    default null,
  p_scope_type     text    default null,
  p_auth_type      text    default null,
  p_outcome        text    default null,
  p_duration_ms    integer default null,
  p_memory_count   integer default null,
  p_result_count   integer default null,
  p_correlation_id text    default null,
  p_client         text    default null,
  p_kind           text    default null,
  p_host           text    default null,
  p_scope          text    default null,
  p_scope_count    integer default null,
  p_session_kind   text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into usage_events (
    user_id, org_id, plan_name,
    tool_name, scope_type, auth_type,
    outcome, duration_ms, memory_count,
    result_count, correlation_id, client, kind, host,
    scope, scope_count, session_kind
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client, p_kind, p_host,
    p_scope, p_scope_count, p_session_kind
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text, integer, text)
  to anon, authenticated, service_role;
