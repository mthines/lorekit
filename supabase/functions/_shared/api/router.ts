import type { AuthContext, ResolvedAuth, DbClient } from './auth.ts';
import { hasPermission, isJwtAuth, analyticsUserId, usageAuthType } from './auth.ts';
import { forbidden, notFound, methodNotAllowed } from './respond.ts';
import { translateDbError } from './errors.ts';
import { recordUsageEvent, getUserPlanName } from '../usage.ts';
import type { UsageEventParams } from '../usage.ts';
import { restToolName } from '../rest-tool-name.ts';
import { classifyResponseOutcome } from '../rest-response-outcome.ts';
import type { Span } from '../otel.ts';

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
 * (`_shared/rest-response-outcome.ts`, mirror of
 * `packages/mcp-core/src/rest-response-outcome.ts`) — see that module for the
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
      // Only from the query string: the router must not consume the request
      // body to peek at a scope, so body-carried scopes report null. Same
      // bounded values as the MCP side (`global`/`project`/`repo`/`branch`).
      const rawScope = url.searchParams.get('scope');
      const scopeType = rawScope ? (rawScope.split('::')[0] ?? 'unknown') : null;
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
      hs.setAttributes({ 'lorekit.tool.name': toolName, ...(scopeType ? { 'lorekit.scope.type': scopeType } : {}) });
      const startedMs = Date.now();

      try {
        const res = await route.handler(req, resolved.auth, resolved.db, hs, params, cors);
        const durationMs = Date.now() - startedMs;
        const planName = planNamePromise ? await planNamePromise : null;
        if (planName) hs.setAttributes({ 'lorekit.plan': planName });
        hs.setAttributes({ 'http.response.status_code': res.status }).end();
        if (usageUserId !== null) {
          recordUsageEvent(resolved.db, {
            userId: usageUserId,
            planName,
            toolName,
            scopeType,
            authType: usageAuthType(resolved.auth),
            outcome: await responseOutcome(res),
            durationMs,
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
            authType: usageAuthType(resolved.auth),
            // A handler that threw a raw cap rejection still counts as a cap
            // hit, not a generic fault — translateDbError is the single
            // SQLSTATE→meaning map, so this can't drift from the 429 above.
            outcome: translateDbError(e)?.code === 'memory_cap' ? 'cap_exceeded' : 'error',
            durationMs,
          });
        }
        throw e;
      }
    },
  };
}
