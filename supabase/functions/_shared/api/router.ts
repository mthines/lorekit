import type { AuthContext, ResolvedAuth, DbClient } from './auth.ts';
import { hasPermission, isJwtAuth } from './auth.ts';
import { forbidden, notFound, methodNotAllowed } from './respond.ts';
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
      try {
        const res = await route.handler(req, resolved.auth, resolved.db, hs, params, cors);
        hs.setAttributes({ 'http.response.status_code': res.status }).end();
        return res;
      } catch (e) {
        hs.error(`${(e as Error).name}: ${(e as Error).message}`).end();
        throw e;
      }
    },
  };
}
