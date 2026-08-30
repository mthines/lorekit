import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound } from '../../../_shared/api/respond.ts';
import { validateOrgSlug } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/telemetry/otel.ts';
import type { Span } from '../../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { isOrgMember, hasOrgCapability } from '../../../_shared/api/tenant.ts';

export async function handleListInvites(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const slug = params.slug ?? '';
  const sv = validateOrgSlug(slug, cors);
  if (!sv.ok) return sv.response;

  span.setAttributes({ 'lorekit.operation': 'invites.list', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db, span);

  // Resolve slug → org_id, then query org_invites directly (no list RPC).
  const { data: org, error: lookupErr } = await tracedDb
    .from('orgs')
    .select('id')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) { span.error(lookupErr.message); throw lookupErr; }
  if (!org) return notFound('Organization', cors);

  // Both selects in this handler are RLS-gated for a JWT caller and completely
  // ungated for an api_key one (service-role client). There is no invite-list
  // RPC to fall back on, so the membership check IS the authorization here:
  // without it, any token holder could read another org's pending invites —
  // including invitee email addresses — by guessing the slug. A non-member gets
  // the same 404 as a non-existent org.
  const orgId = (org as { id: string }).id;
  if (!(await isOrgMember(db, auth, orgId, span))) return notFound('Organization', cors);

  // Membership alone is not enough to READ the invites. `rls_org_invites_select_manage`
  // (00021) shows them only to a caller with the `invite` capability, so a plain
  // member's JWT request already comes back empty. Returning an empty list here
  // — rather than a 403 — is what keeps the api_key tier byte-identical to the
  // JWT tier instead of quietly widening it.
  if (!(await hasOrgCapability(db, auth, orgId, 'invite', span))) {
    span.setAttributes({ 'lorekit.result_count': 0 });
    return ok({ entries: [] }, cors);
  }

  const { data, error } = await tracedDb
    .from('org_invites')
    .select('id,org_id,invitee_email,invitee_handle,role,created_at,expires_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) { span.error(error.message); throw error; }

  span.setAttributes({ 'lorekit.result_count': (data ?? []).length });
  return ok({ entries: data ?? [] }, cors);
}
