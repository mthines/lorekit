import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';


export async function handleGetOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors); if (!sv.ok) return sv.response;
  span.setAttributes({ 'lorekit.operation': 'orgs.get', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.from('orgs').select('id,slug,name,created_at').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (error) { span.error(error.message); throw error; }
  if (!data) return notFound('Organization', cors);
  return ok(data, cors);
}
