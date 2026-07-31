import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
import { ok, notFound, badRequest } from '../../../_shared/api/respond.ts';
import { validateBody, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { RenameOrgBodySchema } from '@lorekit/schemas/org';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { recordRestAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { isOrgMember } from '../../../_shared/api/tenant.ts';


export async function handleRenameOrg(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string,string>, cors: Record<string,string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors); if (!sv.ok) return sv.response;

  const v = await validateBody(req, RenameOrgBodySchema, cors);
  if (!v.ok) return v.response;

  span.setAttributes({ 'lorekit.operation': 'orgs.rename', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);

  // Resolve slug to org_id — RPCs take org_id, not slug.
  const { data: org, error: lookupErr } = await tracedDb
    .from('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  // The slug lookup above is RLS-gated only on the JWT client. Gate it on
  // membership for the api_key tier too, so a non-member gets the same 404 as a
  // non-existent slug rather than a 403 that confirms the org exists. The RPC
  // still owns authorization proper (rename_org -> admin/owner).
  const orgId = (org as { id: string }).id;
  if (!(await isOrgMember(db, auth, orgId, span))) return notFound('Organization', cors);

  const { error } = await tracedDb.rpc('lorekit_org_rename', {
    p_org_id: orgId,
    p_name: v.data.name,
    p_actor_user_id: actorUserId(auth),
  });
  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  // Matches web's renameOrg: the NEW name is the target, so the trail reads
  // "renamed to X" rather than recording only that a rename happened.
  await recordRestAudit(db, span, auth, {
    action: 'org.rename',
    resourceType: 'org',
    resourceId: orgId,
    target: v.data.name,
  });

  return ok({ slug, name: v.data.name }, cors);
}
