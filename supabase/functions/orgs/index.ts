import { traceRequest } from '../_shared/telemetry/otel.ts';
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

// Org routes are gated by TOKEN PERMISSION (read / write), not by auth tier.
//
// They used to all be `requires: 'jwt'`, which 403'd every `lk_rw_*` / `lk_ro_*`
// caller — the reason the CLI still has to hold an MCP transport open purely for
// `org.create` / `org.list` / `org.rename` / `org.delete`. Two things had to be
// true before this could open up, and both now are:
//
//   1. The RPCs can identify an api_key caller. They resolve the acting user via
//      `lorekit_org_actor(p_actor_user_id)` (00041_org_actor_override.sql),
//      which honours an explicitly named actor ONLY on a verified service_role
//      connection. Every handler here passes `actorUserId(auth)`.
//   2. The READS carry their own tenant predicate. The api_key tier uses a
//      service-role client that bypasses RLS, so `GET /orgs` and
//      `GET /orgs/:slug` — which previously leaned entirely on RLS — now filter
//      to the caller's own memberships explicitly (`_shared/api/tenant.ts`).
//
// Authorization itself is unchanged. The role -> capability matrix still lives
// only in `lorekit_org_can`, and a token's read/write permission is orthogonal
// to the holder's org role: a `lk_rw_*` token owned by a viewer still cannot
// rename an org (LK002 -> 403).
const router = createRouter([
  { method: 'GET',    path: '/',                            handler: handleListOrgs,     requires: 'read' },
  { method: 'POST',   path: '/',                            handler: handleCreateOrg,    requires: 'write' },
  { method: 'GET',    path: '/:slug',                       handler: handleGetOrg,       requires: 'read' },
  { method: 'PATCH',  path: '/:slug',                       handler: handleRenameOrg,    requires: 'write' },
  { method: 'DELETE', path: '/:slug',                       handler: handleDeleteOrg,    requires: 'write' },
  { method: 'GET',    path: '/:slug/members',               handler: handleListMembers,  requires: 'read' },
  { method: 'PATCH',  path: '/:slug/members/:userId',       handler: handleChangeRole,   requires: 'write' },
  { method: 'DELETE', path: '/:slug/members/:userId',       handler: handleRemoveMember, requires: 'write' },
  { method: 'GET',    path: '/:slug/invites',               handler: handleListInvites,  requires: 'read' },
  { method: 'POST',   path: '/:slug/invites',               handler: handleCreateInvite, requires: 'write' },
  { method: 'DELETE', path: '/:slug/invites/:inviteId',     handler: handleRevokeInvite, requires: 'write' },
], 'orgs');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);

  return traceRequest(req, 'lorekit.orgs', async (span) => {
    span.setAttributes({ 'lorekit.function': 'orgs' });
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
