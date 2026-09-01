import { traceRequest } from '../_shared/telemetry/otel.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized, internalError } from '../_shared/api/respond.ts';
import { translateDbError, RestError } from '../_shared/api/errors.ts';
import { handleList, handleListPost } from './handlers/list.ts';
import { handleCreate } from './handlers/create.ts';
import { handleGet } from './handlers/get.ts';
import { handleUpdate } from './handlers/update.ts';
import { handleRemove } from './handlers/remove.ts';
import { handleSearch } from './handlers/search.ts';
import { handleRestore } from './handlers/restore.ts';
import { handlePurge, handlePurgeExpired } from './handlers/purge.ts';
import { handleScopes } from './handlers/scopes.ts';
import { handleUsage } from './handlers/usage.ts';
import { handleUsageRuns } from './handlers/usage-runs.ts';
import { handleTags } from './handlers/tags.ts';
import { handleFacets, handleFacetsPost } from './handlers/facets.ts';
import { handleActivity, handleActivityPost } from './handlers/activity.ts';
import { handlePivot, handlePivotPost } from './handlers/pivot.ts';
import { handleReadActivity } from './handlers/read-activity.ts';
import { handleReadRanking } from './handlers/read-ranking.ts';
import { handleRelevant } from './handlers/relevant.ts';
import { handleClusters } from './handlers/clusters.ts';
import { handlePolicyList, handlePolicyCreate, handlePolicyUpdate, handlePolicyDelete } from './handlers/policies.ts';
import { handleGroomPreview, handleGroomRun } from './handlers/groom.ts';
import { handleProtect } from './handlers/protect.ts';

// ROUTE ORDER MATTERS. `matchPath` (../_shared/api/router.ts) matches purely on
// segment COUNT plus literal equality, collects EVERY path match, then picks the
// first whose method also matches. So `/search`, `/restore`, `/purge`,
// `/purge-expired` and `/scopes` are all one segment — exactly like `/:id`, which
// matches any single segment including those literals. The literal routes are
// listed FIRST so the literal always wins on a method collision. Today `/:id`
// has no POST route so `POST /restore` would resolve correctly either way; the
// ordering is explicit precisely so adding `POST /:id` later cannot silently
// swallow the literal routes. The same applies to the two-segment
// `/:id/restore`, which has no literal sibling yet.
//
// Archived listing has NO route of its own: `GET /?archived=true` is the
// `memory.list-archived` equivalent (see handlers/list.ts).
const router = createRouter([
  { method: 'GET',    path: '/',               handler: handleList,         requires: 'read'  },
  { method: 'POST',   path: '/',               handler: handleCreate,       requires: 'write' },
  // Natural-key soft-archive: DELETE /memories?scope=…&key=…. `handleRemove` has
  // always supported the scope+key form, but the route was never registered, so the
  // CLI's `delete`/`archive` (which addresses lore by scope+key, not UUID) got a 405.
  // `?force=true` on either DELETE form hard-deletes instead of archiving.
  { method: 'DELETE', path: '/',               handler: handleRemove,       requires: 'write' },
  // ── literal single-segment routes (must precede `/:id`) ────────────────────
  // The BODY transport for the three filtered reads. Same reads as their GET
  // siblings, decoded from JSON instead of a query string, because a query
  // string caps each dimension at 2048 characters and the URL as a whole at
  // whatever the gateway allows — neither of which an unbounded filter bar
  // fits. Each pairs with its GET route through ONE predicate function, so the
  // transports cannot answer differently.
  { method: 'POST',   path: '/list',           handler: handleListPost,     requires: 'read'  },
  { method: 'POST',   path: '/facets',         handler: handleFacetsPost,   requires: 'read'  },
  { method: 'POST',   path: '/activity',       handler: handleActivityPost, requires: 'read'  },
  { method: 'POST',   path: '/pivot',          handler: handlePivotPost,    requires: 'read'  },
  { method: 'POST',   path: '/search',         handler: handleSearch,       requires: 'read'  },
  { method: 'POST',   path: '/restore',        handler: handleRestore,      requires: 'write' },
  { method: 'POST',   path: '/purge',          handler: handlePurge,        requires: 'write' },
  { method: 'POST',   path: '/purge-expired',  handler: handlePurgeExpired, requires: 'write' },
  { method: 'GET',    path: '/scopes',         handler: handleScopes,       requires: 'read'  },
  { method: 'GET',    path: '/usage',          handler: handleUsage,        requires: 'read'  },
  { method: 'GET',    path: '/usage/runs',     handler: handleUsageRuns,    requires: 'read'  },
  { method: 'GET',    path: '/tags',           handler: handleTags,         requires: 'read'  },
  { method: 'GET',    path: '/facets',         handler: handleFacets,       requires: 'read'  },
  { method: 'GET',    path: '/activity',       handler: handleActivity,     requires: 'read'  },
  { method: 'GET',    path: '/pivot',          handler: handlePivot,        requires: 'read'  },
  { method: 'GET',    path: '/read-activity',  handler: handleReadActivity, requires: 'read'  },
  { method: 'GET',    path: '/read-ranking',   handler: handleReadRanking,  requires: 'read'  },
  { method: 'GET',    path: '/relevant',       handler: handleRelevant,     requires: 'read'  },
  // Near-duplicate clusters. `requires: 'read'` and GET-only by contract, not by
  // omission — see handlers/clusters.ts on why there is no merge counterpart.
  { method: 'GET',    path: '/clusters',       handler: handleClusters,     requires: 'read'  },
  // ── retention policies ("grooming") — literal routes, precede /:id ─────────
  { method: 'GET',    path: '/policies',       handler: handlePolicyList,   requires: 'read'  },
  { method: 'POST',   path: '/policies',       handler: handlePolicyCreate, requires: 'write' },
  { method: 'POST',   path: '/groom/preview',  handler: handleGroomPreview, requires: 'read'  },
  { method: 'POST',   path: '/groom/run',      handler: handleGroomRun,     requires: 'write' },
  { method: 'POST',   path: '/protect',        handler: handleProtect,      requires: 'write' },
  // ── parameterised routes ───────────────────────────────────────────────────
  { method: 'GET',    path: '/:id',            handler: handleGet,          requires: 'read'  },
  { method: 'PATCH',  path: '/:id',            handler: handleUpdate,       requires: 'write' },
  { method: 'DELETE', path: '/:id',            handler: handleRemove,       requires: 'write' },
  { method: 'POST',   path: '/:id/restore',    handler: handleRestore,      requires: 'write' },
  { method: 'PATCH',  path: '/policies/:id',   handler: handlePolicyUpdate, requires: 'write' },
  { method: 'DELETE', path: '/policies/:id',   handler: handlePolicyDelete, requires: 'write' },
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
