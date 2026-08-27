-- ═════════════════════════════════════════════════════════════════════════
-- usage_events.scope_count — HOW MANY scopes an array-bearing call named.
--
-- THE GAP: `memory.search` takes a `scopes` ARRAY; `usage_events.scope` (00058)
-- is ONE text column. So every search recorded `scope = null` — not because the
-- call was unscoped, but because the recording site (`safeValidateScope`) had
-- nothing single-valued to write. In a live 30-day sample this null bucket was
-- the SINGLE LARGEST slice of the per-scope read series (145,260 of 358,782
-- records, ~40%) — almost entirely `memory.search`.
--
-- THE FIX — option (a) from the two considered (see the PR description for the
-- full comparison): a bounded `scope_count` column, `scope` kept exactly as
-- accurate as it already is.
--
--   1. `scope_count`: how many scopes the call named, for ANY scope-bearing
--      tool. Null for a singular-`scope` tool (the RPC's own `default null`).
--      Recorded at the SAME two sites `scope`/`scope_type` already are
--      (`_shared/api/router.ts`, `mcp/mcp-handler.ts`).
--   2. `scope` stays populated for the SINGLE-scope case, whether that single
--      scope arrived as `?scope=`/`toolArgs.scope` OR as a one-element
--      `scopes` array — a search over exactly one repo is exactly as
--      attributable as a `memory.list` over the same repo. TWO OR MORE scopes
--      still record `scope = null`; `scope_count` is the honest answer for
--      that case rather than a guessed single value.
--   3. Why NOT `scopes text[]` (option b, alongside `scope`): the per-scope
--      read series (`lorekit_read_activity`) is a LEADERBOARD whose bars must
--      sum to the account total — a search over 4 scopes attributed to all 4
--      would double-, triple-, quadruple-count its records against that
--      additive invariant. `scope_count` keeps ONE authoritative `scope`
--      column and turns the unattributed bucket into an EXPLAINABLE number
--      ("N searches spanning multiple scopes") instead of a bare null.
--
-- MCP-SIDE BONUS FIX (same functions this migration's application code
-- touches, not a schema change): `mcp-handler.ts` computed `scopeType` via the
-- array-aware `scopeTypeAttribute(rawScope, toolArgs.scopes)` — correctly
-- resolving `mixed` for a multi-repo search — but then gated it behind
-- `rawScope ? scopeType : null` before recording it, discarding that value for
-- every `memory.search` call regardless of what it actually computed.
-- `scopeType` is already total (null exactly when there is nothing to report),
-- so the gate could only ever discard information; it never added safety. Fixed
-- alongside this migration since it is the same code path and the same finding
-- ("scope_type resolves the array to mixed" was the SPAN attribute's behaviour,
-- not the DATABASE COLUMN's, until this fix).
--
-- FAIL-SAFE POSTURE, matching 00054/00058 exactly: `scope_count` is a
-- MEASUREMENT, recorded at the same site and with the same "must never fail
-- the call it measures" contract as `scope`/`client`/`correlation_id`. Filtering
-- BY a scope stays fail-LOUD (`handleReadActivity`'s `validateScope`, unchanged
-- by this migration) — recording and filtering are deliberately different
-- postures, not a single one applied inconsistently.
--
-- Forward-only and additive: the column is nullable, the writer's new
-- parameter is trailing + defaulted, and existing rows are unaffected.
-- ═════════════════════════════════════════════════════════════════════════

-- ── the column ──────────────────────────────────────────────────────────────
alter table usage_events add column if not exists scope_count integer;

-- Bound as a BACKSTOP, not the primary gate — the same reasoning 00044 gives
-- for `usage_events_correlation_id_len` and 00054/00058 for their own columns.
-- The recording site (`toolArgs.scopes.length` / `body.scopes.length`) is
-- already a small, real count; this exists only to stop a malformed or
-- adversarial value from inflating a GROUP BY. 256 is generous headroom over
-- any real `memory.search` call while still being finite.
alter table usage_events drop constraint if exists usage_events_scope_count_range;
alter table usage_events add constraint usage_events_scope_count_range
  check (scope_count is null or (scope_count >= 0 and scope_count <= 256));

-- ── writer: add a trailing p_scope_count ─────────────────────────────────────
-- DROP first (not CREATE OR REPLACE): a new parameter changes the signature,
-- and CREATE OR REPLACE would leave 00058's fifteen-argument overload live
-- alongside this one, making every named-argument call ambiguous. Body is
-- 00058's verbatim plus the one column.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text);

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
  p_scope_count    integer default null
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
    scope, scope_count
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client, p_kind, p_host,
    p_scope, p_scope_count
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text, integer)
  to anon, authenticated, service_role;
