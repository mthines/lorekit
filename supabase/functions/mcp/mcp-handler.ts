/**
 * MCP JSON-RPC dispatcher.
 * Handles initialize, tools/list, and tools/call.
 */

import { type AuthContext, getDb, canWrite, canRead, getUserId, keyRestriction } from './auth.ts';
import { scopeAllowedByKey } from '../_shared/schemas/api-key.ts';
import { type StorageAdapter } from './storage-adapter.ts';
import { UserInputError, safeValidateScope, parseMemoryRefs } from '../_shared/scope/scope.ts';
import { scopeTypeAttribute } from '../_shared/scope/scope-type-attribute.ts';
import { OrgPermissionError, UnknownOrgError } from './org-permissions.ts';
import { TtlError } from './ttl.ts';
import { CreatedAtError } from '../_shared/limits/created-at.ts';
import { type Params } from './tools.ts';
// The dispatch maps are GENERATED from packages/schemas/src/shared/tool-catalog.ts —
// see tool-dispatch.generated.ts. They were hand-written here, which is why a
// regex in tool-catalog-parity.spec.ts had to scrape this file to check them
// against the catalog. Now `satisfies Record<MemoryToolName, unknown>` in the
// generated module makes a missing or misspelled op a COMPILE error instead.
//
// Only the maps moved. Every decision below — the auth gate, the span bracket,
// the try/catch, the usage events — stays here and stays hand-written.
import { MEMORY_TOOLS, ORG_TOOLS, ALL_TOOL_NAMES } from './tool-dispatch.generated.ts';
import { type Span } from '../_shared/telemetry/otel.ts';
import { LimitError, recordUsageEvent, getUserPlanName } from './limits.ts';
import { toolRequires } from './permissions.ts';
import { isRefusedForScopedKey, accountWideRefusalMessage } from '../_shared/auth/account-wide-tools.ts';
import { wireTools } from '../_shared/schemas/tool-catalog.ts';
import { countRecords, parseCorrelationId, parseUsageClient, usageToolKind } from '../_shared/telemetry/usage-stats.ts';
import { parseSessionKind } from '../_shared/telemetry/session-kind.ts';
import { resolveMcpClient, mcpClientAttributes } from '../_shared/telemetry/mcp-client-attribute.ts';
import { resolveKindHost } from '../_shared/schemas/tags.ts';

/**
 * Request header carrying a client-supplied grouping key (PR / session / job),
 * the same seam the REST router reads (`CORRELATION_HEADER`), so a usage event
 * from either surface can be grouped by "this PR". Optional and bounded.
 */
const CORRELATION_HEADER = 'x-lorekit-correlation-id';

/**
 * Request header naming the SURFACE the call came from — the same seam the REST
 * router reads (`CLIENT_HEADER`), so both surfaces attribute an event the same
 * way. This transport IS an MCP call, so an absent/unrecognised header
 * defaults to `mcp` (applied by the caller around the still-closed,
 * still-fail-safe `parseUsageClient` — see its call site below); an explicit
 * header still overrides it, e.g. a locally-hosted stdio server forwarding
 * `cli`.
 */
const CLIENT_HEADER = 'x-lorekit-client';

/**
 * Request header naming the SESSION KIND the call came from (`local`/`ci`/
 * `pr`/`unknown`, migration 00082) — the same seam the REST router reads
 * (`SESSION_KIND_HEADER`). The CLI derives and sends this; this handler only
 * validates (`parseSessionKind`), never derives.
 */
const SESSION_KIND_HEADER = 'x-lorekit-session-kind';

function jsonrpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * JSON-RPC error code for an *authenticated* caller that lacks permission for a
 * specific tool — an authorization failure, NOT an authentication failure.
 * Distinct from the Unauthorized code (-32001) so the two are legible in logs,
 * but both are auth-family errors delivered in-band (see jsonrpcError).
 */
const JSONRPC_FORBIDDEN = -32003;

export function jsonrpcError(id: unknown, code: number, message: string): Response {
  // This is a token-based MCP server (no OAuth), so a 401 buys nothing but a
  // hang: streamable-HTTP clients (mcp-remote) read a 401 on the MCP endpoint as
  // a *session* auth failure and silently retry/reconnect, so the caller's
  // promise never resolves. Deliver every auth-family error IN-BAND at HTTP 200
  // instead — the client parses the JSON-RPC error and surfaces it immediately:
  //   -32001          unauthenticated (missing / invalid / rotated token)
  //   JSONRPC_FORBIDDEN authenticated but not permitted (token permission, key scope)
  // Malformed / internal errors stay 400 (a bad request, not an auth signal).
  // Nothing returns 401 — a fast, legible error always beats a hang.
  const status = code === -32001 || code === JSONRPC_FORBIDDEN ? 200 : 400;
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleMcp(req: Request, auth: AuthContext, span: Span, adapter: StorageAdapter): Promise<Response> {
  // POST-only, and the guard is NOT here — it lives in `index.ts` ABOVE
  // `resolveAuth`, so an SSE-probing client does not pay the authenticated
  // preamble (token + plan + rate-limit, ~319 ms) to be told the method is
  // wrong. `handleMcp` has exactly one caller, so a second copy here would be
  // dead code and a place for the two 405 responses to drift. The ordering is
  // pinned by `packages/mcp-core/src/mcp-guards/mcp-method-guard-ordering.spec.ts`.
  //
  // The consequence for this function: `req.json()` below is only ever reached
  // on a POST, which is what makes the "Unexpected end of JSON input" parse
  // error unreachable for a bare GET.
  let body: { id?: unknown; method?: string; params?: Params };
  try {
    body = await req.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Client sent malformed JSON — not a server fault. Use clientError() so the
    // span is not marked ERROR (OTel: server spans are ERROR only for 5xx faults).
    span.clientError(`ParseError: invalid JSON body — ${detail}`).setAttributes({ 'mcp.method': 'unknown' });
    return jsonrpcError(null, -32700, `Parse error: ${detail}`);
  }

  const { id = null, method, params = {} } = body;

  // WHICH MCP host is calling — the dimension the `oneOf` incident (#654) had
  // no way to ask for. A host that rejects a tool schema rejects it in ITS own
  // process, against ITS own model API, so we see HTTP 200 and a valid result
  // and nothing else ever arrives; the only recoverable signal is the shape of
  // the absence (a host that lists and never calls, or calls every tool but
  // one), and that is unreadable in an aggregate.
  //
  // Read from BOTH inputs, not just the handshake: this server is stateless
  // (protocol `2024-11-05` over plain POSTs, no session), so `clientInfo`
  // arrives on `initialize` ALONE and every `tools/list` / `tools/call` after
  // it is a separate request without it. Labelling only the handshake would
  // leave every tool-call span unlabelled — precisely the per-tool question
  // this exists to answer — so `User-Agent` is the per-request fallback, and
  // the bounded `source` attribute records which one answered. `clientInfo` is
  // read off a parsed JSON body no schema has looked at yet, hence the cast.
  const mcpClient = resolveMcpClient({
    clientInfo: (params as { clientInfo?: unknown }).clientInfo,
    userAgent: req.headers.get('user-agent'),
  });

  span.setAttributes({
    'mcp.method': method ?? 'unknown',
    // Stamped on the ROOT span for EVERY method, which is what makes the
    // funnel queryable: this span already carries `mcp.tool.name` on a
    // `tools/call`, so client × tool is one query and needs no child-span
    // attribute.
    //
    // The version rides on `initialize` only. It is the one value passed
    // through rather than mapped to a closed set (char-allowlisted and capped
    // at 32 in the resolver), and `initialize` is once per session, so a
    // per-request version would put an open-ended dimension on every span.
    ...mcpClientAttributes(mcpClient, { includeVersion: method === 'initialize' }),
  });

  if (method === 'initialize') {
    span.setAttributes({ 'mcp.protocol_version': '2024-11-05' });
    return jsonrpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lorekit', version: '1.1.0' },
    });
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204 });
  }

  if (method === 'tools/list') {
    // Rendered from the canonical catalog in packages/schemas/src/shared/tool-catalog.ts
    // (mirrored here by scripts/codegen/sync-edge-schemas.mjs). The same catalog renders
    // the MCP tools section of llms.txt, so the wire contract and the published
    // docs cannot drift. Add a tool there AND to the dispatch maps above.
    return jsonrpc(id, { tools: wireTools() });
  }

  if (method === 'tools/call') {
    const toolName = params.name as string;
    const toolArgs = params.arguments ?? {};

    if (!ALL_TOOL_NAMES.has(toolName)) {
      // Client requested a non-existent tool — not a server fault.
      span.clientError(`UnknownTool: ${toolName}`).setAttributes({ 'mcp.tool.name': toolName ?? 'unknown' });
      return jsonrpcError(id, -32601, `Unknown tool: ${toolName}`);
    }

    span.setAttributes({ 'mcp.tool.name': toolName });

    const isOrgTool = toolName in ORG_TOOLS;

    // Permission gate, now shared by BOTH families. Org tools used to be
    // refused here outright unless the caller held a dashboard JWT, because
    // their RPCs read `auth.uid()` and a service-role connection has none.
    // `00041_org_actor_override.sql` gave those RPCs an explicit actor
    // parameter, honoured only on a verified service_role connection, and the
    // REST `/orgs` routes have served `lk_*` tokens through it since. This
    // brings MCP onto the same path rather than keeping one surface behind.
    //
    // Authenticated-but-insufficient → JSONRPC_FORBIDDEN (HTTP 200), never
    // -32001: a 401 on this endpoint makes streamable-HTTP clients retry the
    // session instead of surfacing the error. See jsonrpcError().
    const requiredPermission = toolRequires(toolName);
    if (requiredPermission === 'write' && !canWrite(auth)) {
      span
        .clientError('PermissionDenied: read-only token')
        .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'write_permission_missing' });
      return jsonrpcError(id, JSONRPC_FORBIDDEN, 'This token does not have write permission. Use a read+write (lk_rw_) or write-only (lk_wo_) token.');
    }
    if (requiredPermission === 'read' && !canRead(auth)) {
      span
        .clientError('PermissionDenied: write-only token')
        .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'read_permission_missing' });
      return jsonrpcError(id, JSONRPC_FORBIDDEN, 'This token does not have read permission. Use a read+write (lk_rw_) or read-only (lk_ro_) token.');
    }

    // Token permission is NOT authorization to act on an org. It says what the
    // KEY may attempt; `lorekit_org_can` inside the SECURITY DEFINER RPCs still
    // decides what the PERSON may do, so a `lk_rw_*` held by a viewer passes
    // here and is denied there (LK002 → OrgPermissionError → clientError).

    // ── Scope gating: memory tools only ──────────────────────────────────────
    // Org tools carry no `scope`/`scopes` argument, so the checks below would be
    // inert for them. Skipped EXPLICITLY rather than left to that inertness: a
    // future org tool that happened to take a `scope`-named argument would
    // otherwise start silently obeying a memory-shaped rule.
    if (!isOrgTool) {
      // Scope allowlist (migration 00068). Same class of denial as the two
      // above — authenticated, insufficient scope — so the same
      // JSONRPC_FORBIDDEN (HTTP 200), never -32001.
      //
      // This is the EARLY refusal, and it is deliberately not the only one: a
      // tool that names a scope is told plainly that its key may not reach it,
      // instead of getting a confusingly empty result set. Reads that name NO
      // scope are narrowed instead, inside `applyTenantScope`, because there is
      // nothing here to refuse. Writes are additionally gated inside
      // `memory_write`, the only place the edge cannot bypass.
      const restriction = keyRestriction(auth);
      // An account-wide sweep has no scope to check and no result set to
      // narrow, so a restricted key is refused outright — otherwise a key
      // scoped to one repo could hard-delete across every scope its owner has.
      if (isRefusedForScopedKey(toolName, (restriction?.scopes.length ?? 0) > 0)) {
        span
          .clientError('PermissionDenied: account-wide tool on a scoped token')
          .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_account_wide' });
        return jsonrpcError(id, JSONRPC_FORBIDDEN, accountWideRefusalMessage(toolName));
      }
      if (restriction && restriction.scopes.length > 0) {
        // `scopes` (plural) is `memory.search`'s array argument. EVERY named
        // scope must be allowed: refusing the whole call is honest, where
        // silently searching the allowed subset would answer a different
        // question than the one asked.
        const named = [
          ...(typeof toolArgs['scope'] === 'string' ? [toolArgs['scope'] as string] : []),
          ...(Array.isArray(toolArgs['scopes'])
            ? (toolArgs['scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
            : []),
        ];
        const denied = named.find((s) => !scopeAllowedByKey(restriction.scopes, s.toLowerCase().trim()));
        if (denied !== undefined) {
          span
            .clientError('PermissionDenied: scope outside the key allowlist')
            .setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
          return jsonrpcError(
            id,
            JSONRPC_FORBIDDEN,
            `This token is not allowed to use the scope "${denied}". `
              + 'It is restricted to specific scopes — widen it in the dashboard under Settings → API keys.',
          );
        }
      }
    }

    const rawScope = toolArgs['scope'] as string | undefined;
    // A batch `memory.read` names its scopes INSIDE `refs` (`scope::key`
    // strings) — it carries neither `scope` nor `scopes` — so every scope
    // dimension recorded null for it: the `lorekit.scope.type` attribute was
    // omitted, `usage_events.scope_type`/`scope`/`scope_count` were all null,
    // and the `lorekit.tool.duration` histogram put every batch read in the
    // unlabelled bucket of the one dimension it carries. That is the failure
    // `_shared/scope/scope-type-attribute.ts`'s own header records for
    // `memory.search`'s `scopes` array, one array shape later.
    //
    // Parsed by `parseMemoryRefs` — the grammar is never re-split here (the
    // `isReferenceScope` rule is deliberately not `validateScope`, so a second
    // reader would divide `branch::o/r::feat/x::key` differently). It runs a
    // second time inside `toolReadRefs`, which is cheaper over ≤ 32 pure
    // string splits than threading parsed state through dispatch, and it is
    // what makes the dispatcher and the handler agree on which refs the call
    // actually names — including the truncated tail, which is attributed to
    // neither.
    //
    // DISTINCT, unlike `scopes`: an entry of `scopes` IS one scope the caller
    // asked for, whereas many refs routinely name one scope, so the only count
    // that means anything here is how many scopes the batch touched — the same
    // unit `groupRefsByScope` already turns the batch into queries by.
    const refScopes = 'refs' in toolArgs
      ? [...new Set(parseMemoryRefs(toolArgs['refs']).map((r) => r.scope))]
      : undefined;
    // Resolved ONCE and fed to all three consumers below, so the type, the
    // count and the exact scope can never disagree about what the call named.
    // A `scopes` array wins when present; no tool takes both.
    const rawScopes = toolArgs['scopes'] ?? refScopes;
    // BOUNDED, and absent rather than placeholdered. This used to be
    // `rawScope ? rawScope.split('::')[0] : 'unknown'`, which had two failure
    // modes: an ungrammatical scope echoed the caller's own prefix into a
    // dimension declared low-cardinality, and a tool that takes no `scope` at
    // all recorded the literal `unknown`. `memory.search` takes `scopes` (an
    // ARRAY), so EVERY search landed in that placeholder bucket. See
    // `_shared/scope/scope-type-attribute.ts`.
    const scopeType = scopeTypeAttribute(rawScope, rawScopes);
    // How many scopes an ARRAY-bearing call (`memory.search`, or a batch
    // `memory.read`) touched — `usage_events.scope_count` (migration 00078).
    // Undefined for a singular-`scope` tool, matching the RPC's own
    // `default null`. Counted from the SAME array `scopeType` above just read,
    // so the two can never disagree about whether the call carried one at all.
    //
    // Filter blanks ONCE and reuse for both the count and the single-scope
    // resolution below, so the two can never name a different entry: a single
    // real scope preceded by an empty-string entry must still be attributed,
    // not lost to `rawScopes[0]` being that blank.
    const cleanScopes = Array.isArray(rawScopes)
      ? rawScopes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : undefined;
    const scopeCount = cleanScopes?.length;
    // The EXACT scope, for `usage_events.scope` (migration 00058) — what makes
    // "records read from repo::owner/name" answerable, which the deliberately
    // low-cardinality `scopeType` above cannot. Normalised through the canonical
    // validator but TOTAL: an absent or ungrammatical scope records null rather
    // than failing the tool call it is measuring. Resolved ONCE, before the try,
    // so the success and error recording paths cannot disagree about it.
    //
    // A singular `scope` wins when present (no tool takes both). Otherwise, a
    // `scopes` array of exactly ONE entry is just as attributable as a singular
    // scope — `memory.search` searching one repo should not be less attributed
    // than `memory.list` on the same repo — so that one entry is validated the
    // same way. TWO OR MORE scopes stay null: which of several scopes a read
    // "belongs to" is genuinely ambiguous, and `scope_count` (not a guessed
    // scope) is the honest answer for that case (see migration 00078).
    const usageScope = rawScope
      ? safeValidateScope(rawScope)
      : cleanScopes?.length === 1
        ? safeValidateScope(cleanScopes[0])
        : null;
    const toolSpan = span.child(`lorekit.${toolName}`, {
      'lorekit.tool.name': toolName,
      // Omitted when the tool carries no scope at all — the same conditional
      // spread `lorekit.scope` below already uses, and the posture
      // `api/router.ts` states for `auth.user_id`: absent, never empty.
      ...(scopeType ? { 'lorekit.scope.type': scopeType } : {}),
      ...(rawScope ? { 'lorekit.scope': rawScope } : {}),
    });

    // Hoist db above try/catch so the error path can record usage events
    // without re-calling getDb.
    // When BYOD is configured, route all tool-call DB operations to the user's
    // own Supabase project. For hosted mode, derive a correctly-scoped client
    // from the auth context (JWT → user RLS, api_key → service-role).
    //
    // LIMITATION — BYOD + JWT auth: when BYOD mode is active the adapter.db
    // client is built at startup with the LOREKIT_STORAGE_SERVICE_KEY (or the
    // anon key as fallback). A BYOD caller that authenticates via a Supabase JWT
    // does NOT get a per-user-scoped client — the JWT is consumed by *this*
    // hosted function for rate-limiting / auth, but the downstream BYOD database
    // receives the service-key (or anon-key) client, not a JWT-forwarded one.
    // RLS on the BYOD database therefore runs as service role (all rows visible)
    // or anon (policy-dependent), never as the individual JWT user.
    // BYOD users must rely on application-level data isolation in their own
    // Supabase project. If per-user RLS is required, configure the BYOD database
    // to treat service-role writes as trusted and enforce isolation via a
    // user_id column rather than auth.uid()-based policies.
    const db = adapter.mode === 'byod' ? adapter.db : getDb(auth);
    // toolUserId: null for JWT auth (RLS handles scoping), api_key userId otherwise.
    // analyticsUserId: the resolved user ID for usage-event annotation regardless of auth type.
    const toolUserId = getUserId(auth);
    const analyticsUserId = toolUserId ?? (auth.type === 'user' ? auth.userId : null) ?? null;

    // Resolve plan name for usage-event annotation (fails open — null → 'free').
    // Only resolved for authenticated non-service callers; service-role has no plan.
    const planName = auth.type !== 'service' && analyticsUserId
      ? await getUserPlanName(db, analyticsUserId)
      : null;
    if (planName) toolSpan.setAttributes({ 'lorekit.plan': planName });

    // Client-supplied grouping key (same header as the REST surface). Bounded by
    // the pure validator; a malformed value degrades to null, never an error.
    const correlationId = parseCorrelationId(req.headers.get(CORRELATION_HEADER));
    // Calling surface (same header and same fail-safe posture as the REST side).
    // The transport itself IS an MCP call, so an absent/unrecognised header
    // defaults to 'mcp' here — applied by the CALLER, not by widening
    // `parseUsageClient` (which stays a closed, fail-safe validator an unknown
    // value can never smuggle a new member through). An explicit header still
    // wins: a locally-hosted stdio server forwarding `X-LoreKit-Client: cli`
    // reports `cli`, never overridden to `mcp`. This is retroactive for NEW
    // traffic only — historical rows recorded before this change stay NULL.
    const client = parseUsageClient(req.headers.get(CLIENT_HEADER)) ?? 'mcp';
    // Which KIND of session (local/ci/pr/unknown, migration 00082). Never
    // defaulted the way `client` is — there is no "this transport IS a
    // session kind" fact to fall back to, so an absent/unrecognised header
    // stays unattributed.
    const sessionKind = parseSessionKind(req.headers.get(SESSION_KIND_HEADER));
    // Memory taxonomy for analytics — resolved the SAME way the write stores it
    // (explicit kind/host, else inferred from the loop tag). A read that carries
    // a loop tag (memory.list / memory.search filtered by it) is attributed too;
    // it is null only when the args carry neither an explicit value nor a
    // loop tag. Groups usage by family + owner.
    const { kind: usageKind, host: usageHost } = resolveKindHost(toolArgs);

    const toolStartMs = Date.now();

    try {
      let result: unknown;

      if (isOrgTool) {
        // org.* tools: (db, args, toolUserId, span) — the same shape as the
        // memory family, so both maps look alike and this dispatcher threads
        // the actor one way. null for a JWT caller (auth.uid() applies inside
        // the RPCs); the token owner for an api_key caller, forwarded as
        // `p_actor_user_id` and honoured only on a verified service_role
        // connection.
        result = await ORG_TOOLS[toolName as keyof typeof ORG_TOOLS](db, toolArgs, toolUserId, toolSpan);
      } else {
        // memory.* tools: (db, args, toolUserId, span, keyScoping, correlationId)
        // toolUserId is null for JWT auth — RLS handles scoping on the DB side.
        //
        // The trailing `correlationId` is read by `memory.write` alone, for its
        // `cited` array (00107): a citation joins to the run `usage_events`
        // groups by, and that key lives on the REQUEST. It is passed here
        // rather than pulled out of `toolArgs` deliberately — an agent that
        // could name its own correlation id could attribute its citations to
        // somebody else's run. Every other tool ignores the extra argument.
        result = await MEMORY_TOOLS[toolName as keyof typeof MEMORY_TOOLS](
          db, toolArgs, toolUserId, toolSpan, keyRestriction(auth), correlationId,
        );
      }

      const durationMs = Date.now() - toolStartMs;
      toolSpan.setAttributes({ 'lorekit.duration_ms': durationMs });
      toolSpan.end();

      // Record successful usage event (fire-and-forget). For read tools, capture
      // the RECORD count from the result so "read N memories" is a real record
      // total, not a count of read calls. Fail-safe: countRecords returns null
      // when the shape is unknown.
      if (auth.type !== 'service' && analyticsUserId && adapter.supportsHostedBilling) {
        const resultCount = usageToolKind(toolName) === 'read' ? countRecords(result) : null;
        recordUsageEvent(db, {
          userId: analyticsUserId,
          planName,
          toolName,
          // `scopeType` is already TOTAL (`scopeTypeAttribute` returns null
          // when neither `scope` nor `scopes` carries anything) — gating it
          // behind `rawScope` here would discard the array-derived value
          // (e.g. `mixed` for a multi-scope search) precisely for the calls
          // that need it, leaving `usage_events.scope_type` null for every
          // `memory.search` regardless of how many scopes it named. Passed
          // through unconditionally, as its own type already guarantees.
          scopeType,
          scope: usageScope,
          scopeCount,
          authType: auth.type as 'api_key' | 'jwt',
          outcome: 'ok',
          durationMs,
          resultCount,
          correlationId,
          client,
          kind: usageKind,
          host: usageHost,
          sessionKind,
          // WHICH MCP host, bounded (migration 00110). On the SPAN this is
          // stamped for every method; here it is only ever a `tools/call`, and
          // that is the row the funnel needs — a host whose `tools/list` is
          // fine but whose calls for one tool stop.
          mcpClient: mcpClient.name,
        });
      }

      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      const msg = `${(err as Error).name}: ${(err as Error).message}`;
      const durationMs = Date.now() - toolStartMs;
      toolSpan.setAttributes({ 'lorekit.duration_ms': durationMs });

      // UserInputError (bad scope, missing required arg), OrgPermissionError
      // (insufficient role), UnknownOrgError (org slug does not resolve),
      // TtlError (invalid ttl_days/ttl_minutes/ttl_seconds), CreatedAtError
      // (invalid/future created_at override), and LimitError (the account is at
      // its memory cap — returned in-band as an isError result, see below) are
      // all client-caused — the server handled them correctly. Use clientError()
      // so spans are NOT
      // marked ERROR (OTel: server spans are ERROR only for 5xx / server-side
      // faults, not 4xx client errors). A cap hit is expected and recorded
      // separately as usage outcome `cap_exceeded`; flagging the span ERROR too
      // would inflate the `lorekit.mcp` error rate an operator alerts on.
      // Rate-limit LimitErrors never reach here — they are handled before the
      // tool runs (see `index.ts`).
      const isClientError = err instanceof UserInputError
        || err instanceof OrgPermissionError
        || err instanceof UnknownOrgError
        || err instanceof TtlError
        || err instanceof CreatedAtError
        || err instanceof LimitError;
      if (isClientError) {
        toolSpan.clientError(msg).end();
        span.clientError(msg);
      } else {
        toolSpan.error(msg).end();
        span.error(msg);
      }

      // Record failure usage event (fire-and-forget) — distinguishes cap hits
      // from generic errors in plan-sizing analytics.
      if (auth.type !== 'service' && analyticsUserId && adapter.supportsHostedBilling) {
        const outcome = err instanceof LimitError && err.code === 'memory_cap'
          ? 'cap_exceeded'
          : 'error';
        recordUsageEvent(db, {
          userId: analyticsUserId,
          planName: null,  // skip plan lookup on error path to keep it fast
          toolName,
          // See the success branch above — `scopeType` is total, so it is
          // never re-gated behind `rawScope`.
          scopeType,
          scope: usageScope,
          scopeCount,
          authType: auth.type as 'api_key' | 'jwt',
          outcome,
          durationMs,
          correlationId,
          client,
          kind: usageKind,
          host: usageHost,
          sessionKind,
          // See the success branch — recorded on both paths so a client's
          // error rate is answerable, not just its success count.
          mcpClient: mcpClient.name,
        });
      }

      // A failure that ORIGINATED IN THE TOOL goes back inside the RESULT with
      // `isError: true`, not as a JSON-RPC error. The MCP spec is explicit about
      // why, and the reason is the whole point of this branch:
      //
      //   "Any errors that originate from the tool SHOULD be reported inside the
      //    result object, with `isError` set to true, _not_ as an MCP
      //    protocol-level error response. Otherwise, the LLM would not be able
      //    to see that an error occurred and self-correct.
      //    However, any errors in _finding_ the tool […] or any other
      //    exceptional conditions, should be reported as an MCP error response."
      //
      // A protocol error is handled by the CLIENT LIBRARY and may never reach
      // the model at all — mcp-remote surfaces it as a transport failure. So an
      // agent that hit the memory cap used to be told nothing it could act on,
      // when "cap reached, archive something" is precisely the kind of thing an
      // agent CAN fix by itself. Same for a malformed scope, a bad TTL, or an
      // org slug that does not resolve.
      //
      // The dividing line is DISPATCH, which maps onto this try/catch exactly
      // and so cannot drift: everything thrown from inside the tool call is
      // tool-originated; everything refused BEFORE it (parse errors, unknown
      // tool, unknown method, token-permission denials, the account-wide and
      // scope-allowlist refusals) stays a protocol error above. Auth-family
      // errors in particular MUST stay protocol errors travelling in-band —
      // `mcp-authz-status.spec.ts` explains what happens to mcp-remote
      // otherwise, and it is a 30-minute hang, not a worse message.
      //
      // This is the EDGE converging on a posture the product already had: the
      // CLI's local stdio MCP server (`packages/cli/src/commands/mcp-server.mjs`) has
      // always wrapped a failed tool payload in `isError`, and the hook engine's
      // `core/failure.mjs` already reads it. Two MCP surfaces were answering the
      // same class of failure with two different shapes.
      //
      // `isClientError` already computed the "the caller can fix this" set, so
      // this reuses it rather than inventing a second classification. A genuine
      // server fault (a DB outage) is NOT tool-originated in any sense the model
      // can self-correct from, and a client may legitimately retry it, so it
      // remains -32603 — the spec's "other exceptional conditions".
      if (isClientError || err instanceof LimitError) {
        // `(err as Error).message` rather than `msg`: `msg` is class-qualified
        // (`UserInputError: …`) which is useful on a span and noise to a model.
        return jsonrpc(id, {
          content: [{ type: 'text', text: (err as Error).message }],
          isError: true,
        });
      }
      return jsonrpcError(id, -32603, (err as Error).message);
    }
  }

  // Unknown method — client sent an unsupported JSON-RPC method, not a server fault.
  span.clientError(`MethodNotFound: ${method}`);
  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}
