import { traceRequest } from '../_shared/otel.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized, internalError } from '../_shared/api/respond.ts';
import { translateDbError, RestError } from '../_shared/api/errors.ts';
import { handleListOrgs } from './handlers/orgs/list.ts';
import { handleCreateOrg } from './handlers/orgs/create.ts';
import { handleGetOrg } from './handlers/orgs/get.ts';
import { handleRenameOrg } from './handlers/orgs/rename.ts';
import { handleDeleteOrg } from './handlers/orgs/remove.ts';
import { handleListMembers } from './handlers/members/list.ts';
import { handleChangeRole } from './handlers/members/change-role.ts';
import { handleRemoveMember } from './handlers/members/remove.ts';
import { handleListInvites } from './handlers/invites/list.ts';
import { handleCreateInvite } from './handlers/invites/create.ts';
import { handleRevokeInvite } from './handlers/invites/revoke.ts';

const router = createRouter([
  { method: 'GET',    path: '/',                            handler: handleListOrgs,     requires: 'jwt' },
  { method: 'POST',   path: '/',                            handler: handleCreateOrg,    requires: 'jwt' },
  { method: 'GET',    path: '/:slug',                       handler: handleGetOrg,       requires: 'jwt' },
  { method: 'PATCH',  path: '/:slug',                       handler: handleRenameOrg,    requires: 'jwt' },
  { method: 'DELETE', path: '/:slug',                       handler: handleDeleteOrg,    requires: 'jwt' },
  { method: 'GET',    path: '/:slug/members',               handler: handleListMembers,  requires: 'jwt' },
  { method: 'PATCH',  path: '/:slug/members/:userId',       handler: handleChangeRole,   requires: 'jwt' },
  { method: 'DELETE', path: '/:slug/members/:userId',       handler: handleRemoveMember, requires: 'jwt' },
  { method: 'GET',    path: '/:slug/invites',               handler: handleListInvites,  requires: 'jwt' },
  { method: 'POST',   path: '/:slug/invites',               handler: handleCreateInvite, requires: 'jwt' },
  { method: 'DELETE', path: '/:slug/invites/:inviteId',     handler: handleRevokeInvite, requires: 'jwt' },
], 'api-orgs');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);

  return traceRequest(req, 'lorekit.api-orgs', async (span) => {
    span.setAttributes({ 'lorekit.function': 'api-orgs' });
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
