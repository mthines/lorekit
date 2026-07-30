import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleListOrgs(
  _req: Request, _auth: AuthContext, db: DbClient, span: Span,
  _p: Record<string,string>, cors: Record<string,string>,
): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'orgs.list' });
  const tracedDb = createTracedClient(db, span);

  // Mirror packages/web/src/lib/orgs.ts listMyOrgs — joins org_members and orgs.
  // RLS on org_members restricts to the authenticated user's own memberships;
  // RLS on orgs restricts to non-deleted orgs the user belongs to.
  const { data, error } = await tracedDb
    .from('org_members')
    .select('role, orgs(id, slug, name, created_at)')
    .order('created_at', { referencedTable: 'orgs', ascending: false });

  if (error) { span.error(error.message); throw error; }

  const entries = (data ?? []).map((row: Record<string, unknown>) => {
    const org = row.orgs as { id: string; slug: string; name: string; created_at: string } | null;
    return { id: org?.id ?? null, slug: org?.slug ?? null, name: org?.name ?? null, role: row.role, created_at: org?.created_at ?? null };
  });

  span.setAttributes({ 'lorekit.result_count': entries.length });
  return ok({ entries }, cors);
}
