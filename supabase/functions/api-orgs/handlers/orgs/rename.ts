import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { validateBody } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { RenameOrgBodySchema } from '@lorekit/schemas/org';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleRenameOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const v = await validateBody(req, RenameOrgBodySchema, cors);
  if (!v.ok) return v.response;
  span.setAttributes({ 'lorekit.operation': 'orgs.rename', 'lorekit.org_slug': params.slug ?? '' });
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_rename', { p_slug: params.slug, p_name: v.data.name });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return ok(data, cors);
}
