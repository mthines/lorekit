import type { AuthContext } from '../../../_shared/api/auth.ts';
import { actorUserId } from '../../../_shared/api/auth.ts';
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
  // `p_actor_user_id` names the new org's owner. The RPC accepts it only from a
  // verified service_role connection (00041) and raises LK002 -> 403 when it
  // resolves to nobody, so a `service`-tier (CI) call cannot create an ownerless
  // org.
  const { data, error } = await tracedDb.rpc('lorekit_org_create', {
    p_slug: v.data.slug,
    p_name: v.data.name,
    p_actor_user_id: actorUserId(auth),
  });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return created(data, cors);
}
