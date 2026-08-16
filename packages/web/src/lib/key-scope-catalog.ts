import 'server-only';

import { serverAccessToken } from '@/lib/api/session-server';
import { listScopesRequest } from '@/lib/api/memories';
import { listMyOrgs } from '@/lib/orgs';
import { logger } from '@/lib/telemetry';

/**
 * The two catalogs the API-key scoping picker needs: every scope on the account,
 * and every org the signed-in user belongs to.
 *
 * A plain server-side reader rather than a `'use server'` action — nothing
 * mutates, and only server components call it. `server-only` is the guard: a
 * client bundle that reached this module would fail to build rather than
 * shipping the fetch to the browser.
 *
 * Scopes come from `GET /memories/scopes` through the REST client, never a
 * direct PostgREST query — the package's hard rule, and here it earns itself
 * twice over: the endpoint aggregates in Postgres, so the catalog is complete
 * rather than truncated at PostgREST's row cap, and it is the same
 * `lorekit_memory_scopes` the *enforcement* side narrows (00068), so the picker
 * cannot offer a scope the key would then be refused.
 *
 * Both halves fail SOFT, independently. This populates a picker; it does not
 * decide access. An empty scope list costs the user a convenience — they can
 * still create an unscoped key, and the allowlist is validated by the database
 * either way — whereas a thrown error here would take down the whole API-keys
 * page over a catalog read.
 */
export interface KeyScopeCatalog {
  scopes: string[];
  orgs: { id: string; name: string }[];
}

export async function getKeyScopeCatalog(): Promise<KeyScopeCatalog> {
  const [scopes, orgs] = await Promise.all([fetchScopeStrings(), fetchOrgs()]);
  return { scopes, orgs };
}

async function fetchScopeStrings(): Promise<string[]> {
  try {
    const token = await serverAccessToken();
    if (!token) return [];
    const response = await listScopesRequest(token);
    return response.scopes.map((s) => s.scope);
  } catch (error) {
    logger.error('lorekit.api_token.scope_catalog.failed', {
      'exception.type': 'ScopeCatalogError',
      'exception.message': error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function fetchOrgs(): Promise<{ id: string; name: string }[]> {
  // `listMyOrgs` already swallows its own errors and answers `[]`, so there is
  // nothing to catch here — mapping to the two fields the picker needs is all
  // that is left. Deliberately not passing the whole `OrgMembership` through: a
  // picker has no use for the role or the created-at, and a narrower prop is a
  // narrower thing to keep in step.
  const memberships = await listMyOrgs();
  return memberships.map((org) => ({ id: org.id, name: org.name }));
}
