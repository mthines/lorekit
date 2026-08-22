import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
import { ok, notFound, dryRun } from '../../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../../_shared/dry-run.ts';
import { validateBody, validateUuid, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { UpdateMemberRoleBodySchema } from '../../../_shared/schemas/member.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { auditUserId } from '../../../_shared/api/auth.ts';
import { recordAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { isOrgMember } from '../../../_shared/api/tenant.ts';

export async function handleChangeRole(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;
  const idV = validateUuid(params.userId ?? '', cors);
  if (!idV.ok) return idV.response;
  const bodyV = await validateBody(req, UpdateMemberRoleBodySchema, cors);
  if (!bodyV.ok) return bodyV.response;

  span.setAttributes({
    'lorekit.operation': 'members.change_role',
    'lorekit.org_slug': slug,
    'lorekit.target_user': idV.data,
  });

  const tracedDb = createTracedClient(db, span);

  const { data: org, error: lookupErr } = await tracedDb
    .from('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  // Membership gate for the raw slug lookup (no RLS on the api_key tier) — a
  // non-member gets the same 404 as a non-existent slug. `change_role` and the
  // admin-cannot-touch-owner / last-owner invariants stay inside the RPC.
  const orgId = (org as { id: string }).id;
  if (!(await isOrgMember(db, auth, orgId, span))) return notFound('Organization', cors);

  // Dry-run: everything above validated + authorized; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const { error } = await tracedDb.rpc('lorekit_org_member_role', {
    p_org_id: orgId,
    p_target_user_id: idV.data,
    p_role: bodyV.data.role,
    p_actor_user_id: actorUserId(auth),
  });
  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  // Audit AFTER the role change succeeded. Same shape as the dashboard's
  // `changeMemberRole` (packages/web/src/lib/orgs.ts): the SUBJECT of the
  // change is `resourceId`, the org it happened in is `target`.
  await recordAudit(
    db,
    {
      action: 'member.role_change',
      resourceType: 'org_member',
      resourceId: idV.data,
      target: orgId,
      metadata: { role: bodyV.data.role },
    },
    auditUserId(auth),
  );

  return ok({ slug, userId: idV.data, role: bodyV.data.role }, cors);
}
