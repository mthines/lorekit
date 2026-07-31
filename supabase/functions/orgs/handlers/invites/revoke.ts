import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
import { noContent } from '../../../_shared/api/respond.ts';
import { validateUuid } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { auditUserId } from '../../../_shared/api/auth.ts';
import { recordAudit } from '../../../_shared/audit.ts';
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
  // Audit AFTER the revoke succeeded. `lorekit_org_invite_revoke` RAISES on
  // every non-success path (unknown invite, denied capability, non-pending
  // invite), so a null error means a row really changed. Same shape as the
  // dashboard's `revokeInvite` (packages/web/src/lib/org-invites.ts) — invite
  // id only, no `target`; this handler never resolves the org id, and the
  // dashboard row does not carry one either, so adding a lookup here would
  // make the two surfaces LESS comparable, not more.
  await recordAudit(
    db,
    { action: 'member.revoke', resourceType: 'org_invite', resourceId: idV.data },
    auditUserId(auth),
  );
  return noContent(cors);
}
