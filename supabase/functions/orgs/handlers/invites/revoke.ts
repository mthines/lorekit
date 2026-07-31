import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
import { noContent } from '../../../_shared/api/respond.ts';
import { validateUuid } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { recordRestAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleRevokeInvite(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const idV = validateUuid(params.inviteId ?? '', cors);
  if (!idV.ok) return idV.response;
  span.setAttributes({ 'lorekit.operation': 'invites.revoke', 'lorekit.org_slug': params.slug ?? '', 'lorekit.invite_id': idV.data });
  const tracedDb = createTracedClient(db, span);
  // No slug lookup to gate here: the RPC takes the invite id alone, resolves the
  // invite's own org, and requires the `revoke_invite` capability on it — so a
  // non-member gets LK002 -> 403 without any raw table read to leak from. The
  // actor still has to be named explicitly for the api_key tier (00041).
  const { error } = await tracedDb.rpc('lorekit_org_invite_revoke', {
    p_invite_id: idV.data,
    p_actor_user_id: actorUserId(auth),
  });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }

  // Matches web's revokeInvite: the invite id only, no target — the org is not
  // resolved on this path (the RPC derives it from the invite), and inventing a
  // lookup purely to enrich the audit row would add a read the route does not
  // otherwise need.
  await recordRestAudit(db, span, auth, {
    action: 'member.revoke',
    resourceType: 'org_invite',
    resourceId: idV.data,
  });

  return noContent(cors);
}
