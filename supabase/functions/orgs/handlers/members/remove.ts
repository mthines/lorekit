import type { AuthContext } from '../../../_shared/api/auth.ts';
import { noContent, notFound } from '../../../_shared/api/respond.ts';
import { validateUuid, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { auditUserId } from '../../../_shared/api/auth.ts';
import { recordAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

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

  const orgId = (org as { id: string }).id;
  const isSelf = auth.userId === idV.data;

  // Self-removal uses lorekit_org_leave; removing another member uses lorekit_org_member_remove.
  const { error } = isSelf
    ? await tracedDb.rpc('lorekit_org_leave', { p_org_id: orgId })
    : await tracedDb.rpc('lorekit_org_member_remove', { p_org_id: orgId, p_target_user_id: idV.data });

  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  // Audit AFTER the removal succeeded. The action follows the SAME self-vs-
  // other split the RPC choice does, and matches the two distinct dashboard
  // actions (packages/web/src/lib/orgs.ts): `leaveOrg` records `member.leave`
  // with the caller's own id, `removeMember` records `member.remove` with the
  // target's — both with the org id as `target`.
  await recordAudit(
    db,
    {
      action: isSelf ? 'member.leave' : 'member.remove',
      resourceType: 'org_member',
      resourceId: idV.data,
      target: orgId,
    },
    auditUserId(auth),
  );

  return noContent(cors);
}
