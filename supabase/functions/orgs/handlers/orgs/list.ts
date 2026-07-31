import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';
import { applyOwnMembershipFilter } from '../../../_shared/api/tenant.ts';

export async function handleListOrgs(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  _p: Record<string,string>, cors: Record<string,string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'orgs.list' });
  const tracedDb = createTracedClient(db, span);

  // Mirror packages/web/src/lib/orgs.ts listMyOrgs — joins org_members and orgs.
  // RLS on org_members restricts to the authenticated user's own memberships;
  // RLS on orgs restricts to non-deleted orgs the user belongs to.
  //
  // RLS only exists on the JWT client, though. The api_key tier runs on a
  // service-role client, where this exact unfiltered select returns EVERY
  // membership row in the database — so the membership filter is applied
  // explicitly for it. A no-op for JWT (RLS already did it) and for the
  // service/CI tier, which keeps full access exactly as it does in `memories`.
  const { data, error } = await applyOwnMembershipFilter(
    tracedDb
      .from('org_members')
      .select('role, orgs(id, slug, name, created_at)')
      .order('created_at', { referencedTable: 'orgs', ascending: false }),
    auth,
  );

  if (error) { span.error(error.message); throw error; }

  const entries = (data ?? []).map((row: Record<string, unknown>) => {
    const org = row.orgs as { id: string; slug: string; name: string; created_at: string } | null;
    return { id: org?.id ?? null, slug: org?.slug ?? null, name: org?.name ?? null, role: row.role, created_at: org?.created_at ?? null };
  });

  span.setAttributes({ 'lorekit.result_count': entries.length });
  return ok({ entries }, cors);
}
