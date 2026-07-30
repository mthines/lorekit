import type { AuthContext } from '../../../_shared/api/auth.ts';
import { noContent, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';


export async function handleDeleteOrg(
  req: Request, _auth: AuthContext, db: DbClient, span: Span,
  params: Record<string,string>, cors: Record<string,string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors); if (!sv.ok) return sv.response;

  span.setAttributes({ 'lorekit.operation': 'orgs.delete', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);

  // Resolve slug to org_id — lorekit_org_delete takes p_org_id, not slug.
  const { data: org, error: lookupErr } = await tracedDb
    .from('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  const { error } = await tracedDb.rpc('lorekit_org_delete', { p_org_id: (org as { id: string }).id });
  if (error) {
    const m = translateDbError(error);
    if (m) return m.toResponse(cors);
    span.error(error.message);
    throw error;
  }

  return noContent(cors);
}
