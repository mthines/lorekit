import type { AuthContext, ResolvedAuth, DbClient } from './auth.ts';
import { hasPermission, isJwtAuth, analyticsUserId, usageAuthType } from './auth.ts';
import { forbidden, notFound, methodNotAllowed } from './respond.ts';
import { translateDbError } from './errors.ts';
import { recordUsageEvent, getUserPlanName } from '../telemetry/usage.ts';
import type { UsageEventParams } from '../telemetry/usage.ts';
import { restToolName } from '../rest/rest-tool-name.ts';
import { classifyResponseOutcome } from '../rest/rest-response-outcome.ts';
import { parseCorrelationId, parseResultCountHeader, parseUsageClient } from '../telemetry/usage-stats.ts';
import { safeValidateScope } from '../scope/scope.ts';
import { scopeTypeAttribute } from '../scope/scope-type-attribute.ts';
import type { Span } from '../telemetry/otel.ts';

/**
 * Request header carrying a client-supplied grouping key (a PR ref, session id,
 * or job id) so `GET /memories/usage` can answer "usage for THIS PR". Read once
 * here, validated by the pure `parseCorrelationId`, and attached to every usage
 * event this request records. Optional — absent means "no correlation".
 */
export const CORRELATION_HEADER = 'x-lorekit-correlation-id';

/**
 * Response header a collection handler (list/search/get) sets with the number
 * of records it returned. The router reads it once to record the RECORD count
 * on the usage event, so "read 600 memories" is a real record total, not a
 * count of read calls. Fail-safe: an absent/garbage value records no count.
 */
export const RESULT_COUNT_HEADER = 'x-lorekit-result-count';

/**
 * Request header naming the SURFACE the call came from (`dashboard` / `cli` /
 * `mcp` / `api`). Read once here, validated against the closed vocabulary by
 * the pure `parseUsageClient`, and attached to every usage event this request
 * records. Optional — absent means "unattributed".
 *
 * It exists because `auth_type` and `tool_name` cannot tell a human browsing
 * the dashboard apart from an agent listing lore, and the "Memories read"
 * metric has to: the dashboard is a client of this very API, so drawing the
 * card issued a `GET /memories` that the card then counted. Migration 00054
 * excludes `dashboard`-attributed reads from `lorekit_read_activity`.
 */
export const CLIENT_HEADER = 'x-lorekit-client';

/**
 * Response header naming the account the request authenticated as — the
 * caller's OWN id, echoed back to them.
 *
 * Set for every non-service-role caller (see the write site in `createRouter`).
 * It exists for the CLI, whose telemetry runs on the user's machine and has no
 * other way to learn its account: reading it off calls it was already making
 * lets a later OFFLINE run — one that makes no request at all, so no edge span
 * records `auth.user_id` — still report which account it belongs to. Without it,
 * local-only CLI usage is unattributable by construction.
 *
 * Absent, never empty, for service-role: there is no human actor to name. Same
 * posture as the `auth.user_id` span attribute.
 *
 * Kept in step with `USER_ID_HEADER` in `packages/cli/src/shared/mcp.mjs`, and listed
 * in `Access-Control-Expose-Headers` (`cors-origins.ts`) — a browser cannot read
 * a response header that is not exposed, so omitting it there would make this
 * invisible to the dashboard even though it is set.
 */
export const CALLER_USER_ID_HEADER = 'x-lorekit-user-id';

export type Permission = 'read' | 'write' | 'jwt';

export type RouteHandler = (
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
) => Promise<Response>;

export interface Route { method: string; path: string; handler: RouteHandler; requires: Permission; }

function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const ap = actual.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!, a = ap[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return null;
  }
  return params;
}

/**
 * Strip the function's own mount point off the request path.
 *
 * The same function sees two different pathnames depending on who is in front
 * of it, and only the first was handled before:
 *
 *   - `/functions/v1/memories/…`  — the gateway forwarded the full public path
 *   - `/memories/…`               — the gateway already stripped `/functions/v1`
 *
 * In the local `supabase start` stack it is the second, so `GET
 * /functions/v1/memories` arrived here as `/memories`, missed the prefix test,
 * fell through to `/:id`, and answered `Invalid ID: "memories"` instead of
 * listing. That went unnoticed because these functions never booted in CI at
 * all until the import map was removed — the routing bug was hiding behind a
 * `BOOT_ERROR`.
 *
 * Both forms collapse to `/`, so a bare call to either lands on the index
 * route. Pure and total.
 */
export function relativePath(pathname: string, functionName: string): string {
  const mounted = `/functions/v1/${functionName}`;
  const bare = `/${functionName}`;
  for (const prefix of [mounted, bare]) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(prefix + '/')) return pathname.slice(prefix.length) || '/';
  }
  return pathname || '/';
}

/**
 * Read the `code` field a 429 body may carry, then classify.
 *
 * The CLASSIFICATION is the pure, unit-tested `classifyResponseOutcome`
 * (`_shared/rest/rest-response-outcome.ts`, mirror of
 * `packages/mcp-core/src/rest/rest-response-outcome.ts`) — see that module for the
 * full status→outcome mapping and why 429 is the one case needing the body.
 * Only the I/O stays here: the response is cloned on that rare path alone, and
 * never on the response actually returned to the caller. A body that is
 * absent, not JSON, or has no `code` yields `null`, which the classifier maps
 * to `rate_limited` — the same fallback the previous inline `catch` produced.
 */
async function responseOutcome(res: Response): Promise<UsageEventParams['outcome']> {
  if (res.status !== 429) return classifyResponseOutcome(res.status);
  let bodyCode: string | null = null;
  try {
    const body = await res.clone().json() as { code?: string } | null;
    bodyCode = body?.code ?? null;
  } catch {
    bodyCode = null;
  }
  return classifyResponseOutcome(res.status, bodyCode);
}

export function createRouter(routes: Route[], functionName: string) {
  return {
    async dispatch(req: Request, resolved: ResolvedAuth, span: Span, cors: Record<string, string>): Promise<Response> {
      const url = new URL(req.url);
      const rel = relativePath(url.pathname, functionName);
      const method = req.method.toUpperCase();

      const pathMatches = routes.flatMap((r) => { const p = matchPath(r.path, rel); return p !== null ? [{ route: r, params: p }] : []; });
      if (pathMatches.length === 0) return notFound('Route', cors);
      const m = pathMatches.find((x) => x.route.method === method);
      if (!m) return methodNotAllowed(cors);

      const { route, params } = m;
      if (route.requires === 'jwt' && !isJwtAuth(resolved.auth)) return forbidden('This endpoint requires a Supabase JWT (not an API token)', cors);
      if (route.requires === 'read' && !hasPermission(resolved.auth, 'read')) return forbidden('Read permission required', cors);
      if (route.requires === 'write' && !hasPermission(resolved.auth, 'write')) return forbidden('Write permission required', cors);

      const hs = span.child(`lorekit.${functionName}.${method.toLowerCase()}${route.path}`, { 'http.route': route.path });

      // ── usage event (one recording site for the whole REST surface) ────────
      //
      // The structural analogue of mcp-handler.ts's tool dispatch, and for the
      // same reason: an event recorded per handler is an event the next handler
      // forgets. Recorded here, every current and future route is covered by
      // construction.
      //
      // The guard mirrors the MCP one — `auth.type !== 'service' && userId` —
      // minus `adapter.supportsHostedBilling`, which has no REST equivalent:
      // that flag exists to suppress billing telemetry when an MCP caller's
      // data lives in their OWN Supabase project (BYOD). The REST functions
      // have no storage adapter and no BYOD mode at all; they always read and
      // write the hosted database, so the BYOD branch is not merely absent but
      // unrepresentable, and the flag would be a constant `true`.
      const usageUserId = analyticsUserId(resolved.auth);

      // ── caller identity on the ROOT request span ───────────────────────────
      //
      // `resolveRestAuth` already records `auth.type` / `auth.user_id`, but on
      // the `lorekit.rest.auth` CHILD span — so the REST root spans
      // (`lorekit.memories`, `lorekit.orgs`) carried no identity at all and
      // could not be grouped or filtered by user without joining to the child.
      // The MCP surface has always set both on its ROOT span
      // (`mcp/index.ts` — `auth.type`, `auth.user_id`), so this is not a new
      // convention, it is the REST side catching up to the existing one.
      //
      // Why this matters beyond tidiness: the browser, the CLI and the MCP
      // server all authenticate as the SAME LoreKit user and all land here.
      // With the identity on the root span, a web session, a `lorekit` CLI run
      // and an agent's MCP call are joinable on one attribute — no device
      // fingerprinting, no IP heuristics, nothing that could correlate two
      // different people who happen to share a NAT.
      //
      // `usageAuthType` (not `resolved.auth.type`) is deliberate: it normalises
      // REST's `user` to `jwt`, matching what MCP reports and what
      // `usage_events.auth_type` stores, so the surfaces aggregate as ONE
      // series rather than fragmenting on a vocabulary difference. Same
      // rationale as `restToolName`. The child auth span keeps its raw value —
      // changing it would break any existing query filtering on `user`.
      //
      // Service-role has no human actor, so `analyticsUserId` returns null and
      // no `auth.user_id` is written — the attribute is absent, never empty.
      span.setAttributes({
        'auth.type': usageAuthType(resolved.auth),
        ...(usageUserId !== null ? { 'auth.user_id': usageUserId } : {}),
      });

      // Only from the query string: the router must not consume the request
      // body to peek at a scope, so body-carried scopes report null. Same
      // bounded values as the MCP side (`global`/`project`/`repo`/`branch`).
      const rawScope = url.searchParams.get('scope');
      // BOUNDED via the shared `scopeTypeAttribute`, which collapses an
      // ungrammatical `?scope=` into a single `invalid` bucket. The previous
      // inline `split('::')[0]` echoed the caller's own prefix straight into a
      // dimension declared low-cardinality, so a typo'd query string was an
      // unbounded attribute value. Absent scope still reports null, and the
      // attribute is still omitted rather than placeholdered below.
      const scopeType = scopeTypeAttribute(rawScope);
      // The EXACT scope, for `usage_events.scope` (migration 00058) — what makes
      // "records read from repo::owner/name" answerable, which the deliberately
      // low-cardinality `scopeType` above cannot. Read from the SAME query
      // string and for the same reason: the router must not consume the request
      // body, so a body-carried scope records null here exactly as it records a
      // null `scopeType` today. Normalised through the canonical validator but
      // TOTAL — an ungrammatical `?scope=` records null rather than turning a
      // telemetry dimension into a 4xx on the request it is measuring. Resolved
      // ONCE, before the try, so the success and error paths cannot disagree.
      const usageScope = safeValidateScope(rawScope);
      const toolName = restToolName({
        fn: functionName,
        method,
        path: route.path,
        force: url.searchParams.get('force') === 'true',
      });
      // Started, deliberately NOT awaited, before the handler runs. The plan
      // name is only needed to annotate the usage event afterwards, so awaiting
      // it here would put a serial DB round-trip in front of every single REST
      // request purely for telemetry. Kicking it off now and collecting it
      // after means it overlaps the real work and usually costs nothing.
      // `getUserPlanName` never rejects (it fails open to null), so this can
      // not become an unhandled rejection.
      const planNamePromise = usageUserId !== null ? getUserPlanName(resolved.db, usageUserId) : null;
      // Client-supplied grouping key (PR / session / job). Read once, bounded by
      // the pure validator; a malformed header degrades to null, never a 4xx.
      const correlationId = parseCorrelationId(req.headers.get(CORRELATION_HEADER));
      // Calling surface (dashboard / cli / mcp / api). Same fail-safe posture:
      // an absent or unrecognised value records no attribution rather than
      // rejecting the request or admitting an unbounded value.
      //
      // This router IS the REST transport, so an absent/unrecognised header
      // defaults to 'api' — applied HERE by the caller, not by widening
      // `parseUsageClient` itself (still a closed, fail-safe validator; an
      // unknown value still cannot smuggle a new member into the ledger). An
      // explicit header still wins: the dashboard's own `dashboard` and the
      // CLI's `cli` are unaffected. Retroactive for NEW traffic only —
      // historical rows recorded before this change stay NULL.
      const client = parseUsageClient(req.headers.get(CLIENT_HEADER)) ?? 'api';
      hs.setAttributes({ 'lorekit.tool.name': toolName, ...(scopeType ? { 'lorekit.scope.type': scopeType } : {}) });
      const startedMs = Date.now();

      try {
        const res = await route.handler(req, resolved.auth, resolved.db, hs, params, cors);
        const durationMs = Date.now() - startedMs;
        const planName = planNamePromise ? await planNamePromise : null;
        if (planName) hs.setAttributes({ 'lorekit.plan': planName });
        hs.setAttributes({ 'http.response.status_code': res.status }).end();
        // ── tell the caller which account it authenticated as ────────────────
        //
        // The CLI's only cheap route to its own account id. It has no `/me`
        // call, and its telemetry runs on the user's machine where nothing else
        // knows the account: without this, a local-only CLI run (offline store,
        // `lorekit hook`) is unattributable, because it makes no request for the
        // edge to record `auth.user_id` on. The CLI caches this value and stamps
        // it on subsequent offline runs — see `packages/cli/src/store/remote.mjs`.
        //
        // Disclosing it is not a widening: this is the caller's OWN id, returned
        // only to a request that already authenticated as them, and it is
        // already what every row they can read is keyed by. Service-role gets
        // nothing (`analyticsUserId` returns null — no human actor to name), so
        // the header is absent rather than empty, matching how the same value is
        // treated as a span attribute.
        if (usageUserId !== null) res.headers.set(CALLER_USER_ID_HEADER, usageUserId);
        if (usageUserId !== null) {
          // Record count from the handler's own header — fail-safe to null.
          const resultCount = parseResultCountHeader(res.headers.get(RESULT_COUNT_HEADER));
          recordUsageEvent(resolved.db, {
            userId: usageUserId,
            planName,
            toolName,
            scopeType,
            scope: usageScope,
            authType: usageAuthType(resolved.auth),
            outcome: await responseOutcome(res),
            durationMs,
            resultCount,
            correlationId,
            client,
          });
        }
        return res;
      } catch (e) {
        const durationMs = Date.now() - startedMs;
        hs.error(`${(e as Error).name}: ${(e as Error).message}`).end();
        if (usageUserId !== null) {
          recordUsageEvent(resolved.db, {
            userId: usageUserId,
            planName: null, // skip the plan lookup on the error path to keep it fast
            toolName,
            scopeType,
            scope: usageScope,
            authType: usageAuthType(resolved.auth),
            // A handler that threw a raw cap rejection still counts as a cap
            // hit, not a generic fault — translateDbError is the single
            // SQLSTATE→meaning map, so this can't drift from the 429 above.
            outcome: translateDbError(e)?.code === 'memory_cap' ? 'cap_exceeded' : 'error',
            durationMs,
            correlationId,
            client,
          });
        }
        throw e;
      }
    },
  };
}
