import { traceRequest } from '../_shared/otel.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized, internalError } from '../_shared/api/respond.ts';
import { translateDbError, RestError } from '../_shared/api/errors.ts';
import { handleList } from './handlers/list.ts';
import { handleCreate } from './handlers/create.ts';
import { handleGet } from './handlers/get.ts';
import { handleUpdate } from './handlers/update.ts';
import { handleRemove } from './handlers/remove.ts';
import { handleSearch } from './handlers/search.ts';

const router = createRouter([
  { method: 'GET',    path: '/',        handler: handleList,   requires: 'read'  },
  { method: 'POST',   path: '/',        handler: handleCreate, requires: 'write' },
  // Natural-key soft-archive: DELETE /memories?scope=…&key=…. `handleRemove` has
  // always supported the scope+key form, but the route was never registered, so the
  // CLI's `delete`/`archive` (which addresses lore by scope+key, not UUID) got a 405.
  { method: 'DELETE', path: '/',        handler: handleRemove, requires: 'write' },
  { method: 'GET',    path: '/:id',     handler: handleGet,    requires: 'read'  },
  { method: 'PATCH',  path: '/:id',     handler: handleUpdate, requires: 'write' },
  { method: 'DELETE', path: '/:id',     handler: handleRemove, requires: 'write' },
  { method: 'POST',   path: '/search',  handler: handleSearch, requires: 'read'  },
], 'memories');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);

  return traceRequest(req, 'lorekit.memories', async (span) => {
    span.setAttributes({ 'lorekit.function': 'memories' });

    const resolved = await resolveRestAuth(req, span);
    if (!resolved) return unauthorized(cors);

    try {
      return await router.dispatch(req, resolved, span, cors);
    } catch (e) {
      if (e instanceof RestError) return e.toResponse(cors);
      const mapped = translateDbError(e);
      if (mapped) return mapped.toResponse(cors);
      span.error(`Unhandled: ${(e as Error).message}`);
      return internalError(cors);
    }
  });
});
