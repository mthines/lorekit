import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleListInvites(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  span.setAttributes({ 'lorekit.operation': 'invites.list', 'lorekit.org_slug': params.slug ?? '' });
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_invite_list', { p_slug: params.slug });
  if (error) { span.error(error.message); throw error; }
  return ok({ entries: data ?? [] }, cors);
}
