import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { isOrgMember } from '../../../_shared/api/tenant.ts';


export async function handleGetOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors); if (!sv.ok) return sv.response;
  span.setAttributes({ 'lorekit.operation': 'orgs.get', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.from('orgs').select('id,slug,name,created_at').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (error) { span.error(error.message); throw error; }
  if (!data) return notFound('Organization', cors);

  // The select above is gated by `rls_orgs_select` for a JWT caller and by
  // NOTHING for an api_key caller (service-role client, no RLS) — as written it
  // would hand any org to anyone who guesses its slug. `isOrgMember` restores
  // the membership requirement using `lorekit_member_org_ids`, the same
  // predicate the RLS policy encodes.
  //
  // The response for a non-member is byte-identical to the response for a slug
  // that does not exist. Anything else (403, or a different body) turns this
  // route into an org-existence oracle over the whole slug namespace.
  const orgId = (data as { id: string }).id;
  if (!(await isOrgMember(db, auth, orgId, span))) return notFound('Organization', cors);

  return ok(data, cors);
}
