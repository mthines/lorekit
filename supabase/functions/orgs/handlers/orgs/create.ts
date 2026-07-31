import type { AuthContext } from '../../../_shared/api/auth.ts';
import { created } from '../../../_shared/api/respond.ts';
import { validateBody } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { CreateOrgBodySchema } from '../../../_shared/schemas/org.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleCreateOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, _p: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const v = await validateBody(req, CreateOrgBodySchema, cors);
  if (!v.ok) return v.response;
  span.setAttributes({ 'lorekit.operation': 'orgs.create', 'lorekit.org_slug': v.data.slug });
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_create', { p_slug: v.data.slug, p_name: v.data.name });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return created(data, cors);
}
