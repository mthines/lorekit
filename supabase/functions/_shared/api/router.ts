/**
 * Minimal HTTP router for LoreKit REST Edge Functions.
 *
 * Each REST function (rest-memories/, rest-orgs/) uses a route table to
 * dispatch requests to typed handler functions. The router handles:
 *   - Method matching (GET, POST, PATCH, DELETE)
 *   - Path segment extraction (e.g. /:id, /:slug, /:slug/members/:userId)
 *   - Permission gate (requires 'read' or 'write')
 *   - 405 Method Not Allowed for unmatched methods on known paths
 *
 * Usage:
 *   const router = createRouter('/rest-memories', [
 *     { method: 'GET',   pattern: '',      handler: handleList,   requires: 'read' },
 *     { method: 'POST',  pattern: '',      handler: handleCreate, requires: 'write' },
 *     { method: 'POST',  pattern: '/search', handler: handleSearch, requires: 'read' },
 *     { method: 'GET',   pattern: '/:id',  handler: handleGet,    requires: 'read' },
 *     { method: 'PATCH', pattern: '/:id',  handler: handleUpdate, requires: 'write' },
 *     { method: 'DELETE', pattern: '/:id', handler: handleRemove, requires: 'write' },
 *   ]);
 *
 *   // In Deno.serve:
 *   return router.dispatch(req, auth, db, span);
 */

import type { AuthContext } from './auth.ts';
import { canRead, canWrite } from './auth.ts';
import { methodNotAllowed, notFound, forbidden } from './respond.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Span } from '../otel.ts';

export type RouteHandler = (
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  params: Record<string, string>,
) => Response | Promise<Response>;

export interface RouteDefinition {
  method: string;
  /** Path pattern relative to the function prefix. Use `:name` for params. */
  pattern: string;
  handler: RouteHandler;
  requires: 'read' | 'write' | 'jwt';
}

interface Router {
  dispatch(
    req: Request,
    auth: AuthContext,
    db: ReturnType<typeof createClient>,
    span: Span,
  ): Response | Promise<Response>;
}

/**
 * Build a path pattern regex and extract param names.
 * Example: '/:id' → regex /^\/([^/]+)$/ with paramNames ['id']
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = pattern
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

/**
 * Create a router for a REST Edge Function.
 *
 * @param prefix    The URL path prefix for this function, e.g. '/rest-memories'
 * @param routes    Route definitions
 */
export function createRouter(prefix: string, routes: RouteDefinition[]): Router {
  const compiled = routes.map((route) => ({
    ...route,
    ...compilePattern(route.pattern),
  }));

  return {
    dispatch(req, auth, db, span) {
      const url = new URL(req.url);
      const fullPath = url.pathname;
      const method = req.method.toUpperCase();

      // Strip the Supabase functions base path and the function name prefix
      // URL format: /functions/v1/rest-memories[/...] or /rest-memories[/...]
      let path = fullPath;
      const fnMatch = path.match(/\/functions\/v1\/[^/]+(\/.*)$/);
      if (fnMatch) path = fnMatch[1] ?? '';
      else {
        // Already stripped, just remove the prefix
        if (path.startsWith(prefix)) path = path.slice(prefix.length);
        if (!path.startsWith('/')) path = '/' + path;
      }
      // Normalize trailing slash
      if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
      if (path === '') path = '/';

      // Find a matching route (method + pattern)
      let pathMatched = false;
      for (const route of compiled) {
        const match = route.regex.exec(path);
        if (!match) continue;

        pathMatched = true;
        if (route.method !== method) continue;

        // Check permission
        if (route.requires === 'jwt' && auth.type !== 'user') {
          return forbidden('This endpoint requires a Supabase user JWT session. API key tokens are not accepted.');
        }
        if (route.requires === 'read' && !canRead(auth)) {
          return forbidden('Read permission required. Use an lk_rw_* or lk_ro_* token.');
        }
        if (route.requires === 'write' && !canWrite(auth)) {
          return forbidden('Write permission required. Use an lk_rw_* or lk_wo_* token.');
        }

        // Extract path params
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const name = route.paramNames[i];
          const value = match[i + 1];
          if (name && value) params[name] = decodeURIComponent(value);
        }

        return route.handler(req, auth, db, span, params);
      }

      if (pathMatched) return methodNotAllowed();
      return notFound(`No route for ${method} ${path}`);
    },
  };
}
