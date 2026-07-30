import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { Tables } from '../../../_shared/database.types.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

type InviteRow = Tables<'org_invites'>;

export async function handleListInvites(
  _req: Request, _auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;

  span.setAttributes({ 'lorekit.operation': 'invites.list', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);

  // Resolve slug → org_id, then query org_invites directly (no list RPC).
  const { data: org, error: lookupErr } = await tracedDb
    .from<{ id: string }>('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  const { data, error } = await tracedDb
    .from<InviteRow>('org_invites')
    .select('id,org_id,invitee_email,invitee_handle,role,created_at,expires_at')
    .eq('org_id', (org as { id: string }).id)
    .order('created_at', { ascending: false });

  if (error) { span.error(error.message); throw error; }

  span.setAttributes({ 'lorekit.result_count': (data ?? []).length });
  return ok({ entries: data ?? [] }, cors);
}
