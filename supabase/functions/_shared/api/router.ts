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

export function createRouter(routes: Route[], functionName: string) {
  return {
    async dispatch(req: Request, resolved: ResolvedAuth, span: Span, cors: Record<string, string>): Promise<Response> {
      const url = new URL(req.url);
      const prefix = `/functions/v1/${functionName}`;
      const rel = url.pathname.startsWith(prefix) ? (url.pathname.slice(prefix.length) || '/') : url.pathname;
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
