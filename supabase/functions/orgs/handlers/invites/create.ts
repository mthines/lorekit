import type { AuthContext } from '../../../_shared/api/auth.ts';
import { created, notFound } from '../../../_shared/api/respond.ts';
import { validateBody, validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { CreateInviteBodySchema } from '../../../_shared/schemas/invite.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { auditUserId } from '../../../_shared/api/auth.ts';
import { recordAudit } from '../../../_shared/audit.ts';
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

  // Audit AFTER the invite was created. Same shape as the dashboard's
  // `inviteMember` (packages/web/src/lib/org-invites.ts): the invite is the
  // resource, the org is the `target`, and `metadata.invitee` is the single
  // identity string that was invited — the schema guarantees exactly one of
  // email/handle is present (its `.refine`), so this is never empty.
  await recordAudit(
    db,
    {
      action: 'member.invite',
      resourceType: 'org_invite',
      resourceId: data as unknown as string,
      target: orgId,
      metadata: { invitee: v.data.email ?? v.data.handle, role: v.data.role },
    },
    auditUserId(auth),
  );

  return created({ inviteId: data }, cors);
}
