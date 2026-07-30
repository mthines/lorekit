import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok, notFound, badRequest } from '../../../_shared/api/respond.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function handleGetOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const slug = params.slug ?? '';
  if (!SLUG_RE.test(slug)) return badRequest('Invalid org slug', undefined, cors);
  span.setAttributes({ 'lorekit.operation': 'orgs.get', 'lorekit.org_slug': slug });
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.from('orgs').select('id,slug,name,created_at').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (error) { span.error(error.message); throw error; }
  if (!data) return notFound('Organization', cors);
  return ok(data, cors);
}
