import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
import { noContent, notFound } from '../../../_shared/api/respond.ts';
import { validateUuid, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { recordRestAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { isOrgMember } from '../../../_shared/api/tenant.ts';

export async function handleRemoveMember(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;
  const idV = validateUuid(params.userId ?? '', cors);
  if (!idV.ok) return idV.response;

  span.setAttributes({
    'lorekit.operation': 'members.remove',
    'lorekit.org_slug': slug,
    'lorekit.target_user': idV.data,
  });

  const tracedDb = createTracedClient(db, span);

  const { data: org, error: lookupErr } = await tracedDb
    .from<{ id: string }>('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  // Membership gate for the raw slug lookup (no RLS on the api_key tier) — a
  // non-member gets the same 404 as a non-existent slug. `remove_member` and
  // the last-owner / admin-vs-owner invariants stay inside the RPC.
  const orgId = (org as { id: string }).id;
  if (!(await isOrgMember(db, auth, orgId, span))) return notFound('Organization', cors);

  const isSelf = auth.userId === idV.data;

  // Self-removal uses lorekit_org_leave; removing another member uses lorekit_org_member_remove.
  //
  // KNOWN GAP: `lorekit_org_leave` deliberately gained no actor override in
  // 00041 (see that migration's header), so it still resolves the actor as
  // `auth.uid()`. On the api_key tier that is NULL, so self-removal fails closed
  // with LK002 -> 403 instead of removing someone else's row. Leaving an org
  // from an API token is a follow-up, not a silently broken path.
  const { error } = isSelf
    ? await tracedDb.rpc('lorekit_org_leave', { p_org_id: orgId })
    : await tracedDb.rpc('lorekit_org_member_remove', {
        p_org_id: orgId,
        p_target_user_id: idV.data,
        p_actor_user_id: actorUserId(auth),
      });

  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  // The action follows the RPC that actually ran, not the route: this endpoint
  // is both "kick a member" and "leave", and web audits those as `member.remove`
  // (removeMember) and `member.leave` (leaveOrg) respectively. Emitting
  // `member.remove` for a self-removal would make the same operation read
  // differently depending on which client performed it. Field layout matches web
  // exactly — the affected user as resourceId, the org id as target.
  await recordRestAudit(db, span, auth, {
    action: isSelf ? 'member.leave' : 'member.remove',
    resourceType: 'org_member',
    resourceId: idV.data,
    target: orgId,
  });

  return noContent(cors);
}
