import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleListOrgs(req: Request, auth: AuthContext, db: DbClient, span: Span, _p: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'orgs.list' });
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_list', {});
  if (error) { span.error(error.message); throw error; }
  return ok({ entries: data ?? [] }, cors);
}
