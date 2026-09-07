-- ═════════════════════════════════════════════════════════════════════════
-- usage_events.mcp_client — WHICH MCP host is talking to us?
--
-- THE GAP, and it cost us production. `memory.read`'s top-level `oneOf` (#654)
-- made Amazon Bedrock reject the WHOLE `tools/list` response, so every
-- Bedrock-hosted agent lost the LoreKit server outright; a second MCP client
-- independently dropped `memory.read` — and only `memory.read` — from a
-- 22-tool list. Neither failure produced a single error on this side. We
-- answered `tools/list` with HTTP 200 and a valid JSON-RPC result and the
-- rejection happened AFTERWARDS, inside the host's own process, against the
-- host's own model API. The last event in our system was a success.
--
-- No callback exists, so the upstream error text is unrecoverable. What IS
-- recoverable is the SHAPE of the absence — and both shapes are only legible
-- per client:
--
--   hard failure — a host that handshakes, lists, and then never calls a tool.
--   degradation  — a host that keeps calling every tool EXCEPT the one whose
--                  schema it refused.
--
-- Neither is visible in an aggregate: total traffic barely moves when one host
-- family drops out, and "memory.read calls fell" is unreadable without knowing
-- whose. This column is the dimension that makes both queryable.
--
-- WHY `mcp_client` AND NOT `client`. `usage_events.client` (00054) already
-- means the SURFACE — dashboard / cli / mcp / api, from `X-LoreKit-Client` —
-- and `host` (00056) already means a memory bucket's owning host. Both obvious
-- words are spent with unrelated meanings, so this one is namespaced. It is
-- `lorekit.mcp.client.name` on spans (deliberately NOT `mcp.client.name`:
-- upstream OTel semconv 1.43.0 spends the `mcp.client.*` prefix on client-role
-- METRIC names and defines no client-identity attribute, so squatting there
-- would collide with a reserved namespace).
--
-- BOUNDED, in app code. The inputs are caller-supplied free text — the
-- `initialize` handshake's `clientInfo.name`, and `User-Agent` for every
-- subsequent request, since this server is stateless and `clientInfo` arrives
-- once — so `_shared/telemetry/mcp-client-attribute.ts` maps them to a closed
-- vocabulary (`other` for a client that named itself and is not catalogued;
-- OMITTED when nothing identified the caller). This migration adds the
-- 00054/00082 length CHECK as a backstop only, never a CHECK enumerating
-- members: the vocabulary is expected to grow as clients are catalogued, and a
-- direct insert must simply not be able to put an unbounded value into a
-- column every chart groups on.
--
-- Forward-only and additive: the column is nullable and the writer's new
-- parameter is trailing + defaulted, so every existing row and caller is
-- unaffected — the REST surface passes nothing and stays null, correctly, as
-- a REST call has no MCP client. Retroactive for NEW traffic only.
-- ═════════════════════════════════════════════════════════════════════════

alter table usage_events add column if not exists mcp_client text;

-- Bound as a BACKSTOP, matching 00082's `usage_events_session_kind_len` and
-- 00054's `usage_events_client_len` exactly. 32 rather than 16 because these
-- ids are HOST NAMES, not a fixed enum: the longest catalogued today is
-- `claude-desktop` at 14, so 16 would leave two characters of headroom before
-- the next client to be catalogued has to argue with a constraint. No index,
-- matching 00082 — add one when a query needs it, not speculatively.
alter table usage_events drop constraint if exists usage_events_mcp_client_len;
alter table usage_events add constraint usage_events_mcp_client_len
  check (mcp_client is null or (char_length(mcp_client) between 1 and 32));

-- ── writer: add a trailing p_mcp_client ──────────────────────────────────
-- DROP first: a new parameter changes the signature. The dropped signature is
-- 00082's seventeen-argument one (…, p_scope_count, p_session_kind) — a stale
-- drop target is silent, leaving two overloads live and every named-argument
-- call ambiguous.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text, integer, text);

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
  p_session_kind   text    default null,
  p_mcp_client     text    default null
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
    scope, scope_count, session_kind, mcp_client
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client, p_kind, p_host,
    p_scope, p_scope_count, p_session_kind, p_mcp_client
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text, integer, text, text)
  to anon, authenticated, service_role;
