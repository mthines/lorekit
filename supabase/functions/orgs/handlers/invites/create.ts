import type { AuthContext } from '../../../_shared/api/auth.ts';
import { created } from '../../../_shared/api/respond.ts';
import { validateBody } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { CreateInviteBodySchema } from '@lorekit/schemas/invite';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleCreateInvite(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const v = await validateBody(req, CreateInviteBodySchema, cors);
  if (!v.ok) return v.response;
  span.setAttributes({ 'lorekit.operation': 'invites.create', 'lorekit.org_slug': params.slug ?? '' });
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_invite', { p_slug: params.slug, p_email: v.data.email ?? null, p_handle: v.data.handle ?? null, p_role: v.data.role });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return created(data, cors);
}
