import type { AuthContext } from '../../../_shared/api/auth.ts';
import { created, notFound } from '../../../_shared/api/respond.ts';
import { validateBody, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { CreateInviteBodySchema } from '@lorekit/schemas/invite';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { recordRestAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleCreateInvite(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;

  const v = await validateBody(req, CreateInviteBodySchema, cors);
  if (!v.ok) return v.response;

  span.setAttributes({ 'lorekit.operation': 'invites.create', 'lorekit.org_slug': slug });
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
  const { data, error } = await tracedDb.rpc('lorekit_org_invite', {
    p_org_id: orgId,
    p_invitee_email: v.data.email ?? null,
    p_invitee_handle: v.data.handle ?? null,
    p_role: v.data.role,
  });
  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  // Matches web's inviteMember: the invite id as resourceId, the org id as
  // target, and `{ invitee, role }` in metadata. `invitee` is the single
  // identity string web records — this route takes email/handle as separate
  // fields, so whichever was supplied is the invitee.
  await recordRestAudit(db, span, auth, {
    action: 'member.invite',
    resourceType: 'org_invite',
    resourceId: typeof data === 'string' ? data : null,
    target: orgId,
    metadata: { invitee: v.data.email ?? v.data.handle ?? null, role: v.data.role },
  });

  return created({ inviteId: data }, cors);
}
