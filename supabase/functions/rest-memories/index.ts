/**
 * LoreKit REST Memories Edge Function
 *
 * Routes:
 *   GET    /rest-memories          list memories (paginated, filterable)
 *   POST   /rest-memories          create or update a memory
 *   POST   /rest-memories/search   search with FTS + scope/tag filters
 *   GET    /rest-memories/:id      get a single memory by UUID
 *   PATCH  /rest-memories/:id      partial update
 *   DELETE /rest-memories/:id      soft-archive (or ?force=true for hard-delete)
 *
 * Auth: Bearer token (lk_rw_*, lk_ro_*, lk_wo_*, Supabase JWT, or service-role key)
 * Tenant scoping: always applied (api_key → explicit user_id filter; JWT → RLS)
 * Rate limiting: DB-backed lorekit_check_rate_limit RPC (same as MCP)
 * Tracing: W3C traceparent header forwarded → full CLI/mcp-server → REST → DB traces
 *
 * Required secrets (supabase secrets set):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OTEL_EXPORTER_OTLP_ENDPOINT
 *   OTEL_EXPORTER_OTLP_HEADERS
 *   ALLOWED_ORIGINS (optional — defaults to lorekit.io + localhost)
 */

import { traceRequest } from '../_shared/otel.ts';
import { resolveAuth, getDb } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized } from '../_shared/api/respond.ts';

import { handleList } from './handlers/list.ts';
import { handleCreate } from './handlers/create.ts';
import { handleGet } from './handlers/get.ts';
import { handleUpdate } from './handlers/update.ts';
import { handleRemove } from './handlers/remove.ts';
import { handleSearch } from './handlers/search.ts';

const router = createRouter('/rest-memories', [
  // Specific routes before parameterized routes (router matches in order)
  { method: 'POST',   pattern: '/search', handler: handleSearch, requires: 'read'  },
  { method: 'GET',    pattern: '',        handler: handleList,   requires: 'read'  },
  { method: 'POST',   pattern: '',        handler: handleCreate, requires: 'write' },
  { method: 'GET',    pattern: '/:id',    handler: handleGet,    requires: 'read'  },
  { method: 'PATCH',  pattern: '/:id',    handler: handleUpdate, requires: 'write' },
  { method: 'DELETE', pattern: '/:id',    handler: handleRemove, requires: 'write' },
]);

Deno.serve(async (req: Request) => {
  // Handle CORS preflight before auth
  if (req.method === 'OPTIONS') return handlePreflight(req);

  return traceRequest(req, 'lorekit.rest.memories', async (span) => {
    const auth = await resolveAuth(req, span);
    if (!auth) return unauthorized('Authentication required. Provide a Bearer token.');

    const db = getDb(auth);
    return router.dispatch(req, auth, db, span);
  });
});
