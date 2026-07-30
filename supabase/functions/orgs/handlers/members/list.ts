import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { Database } from '../../../_shared/database.types.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

type MemberRow = Database['public']['Functions']['lorekit_org_members_list']['Returns'][number];

export async function handleListMembers(
  _req: Request, _auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;

  span.setAttributes({ 'lorekit.operation': 'members.list', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);

  // Resolve slug → org_id (all member/invite RPCs take p_org_id).
  const { data: org, error: lookupErr } = await tracedDb
    .from<{ id: string }>('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  const { data, error } = await tracedDb.rpc<MemberRow>('lorekit_org_members_list', { p_org_id: (org as { id: string }).id });
  if (error) { span.error(error.message); throw error; }

  span.setAttributes({ 'lorekit.result_count': (data ?? []).length });
  return ok({ entries: data ?? [] }, cors);
}
