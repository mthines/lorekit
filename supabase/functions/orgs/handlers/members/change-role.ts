import type { AuthContext } from '../../../_shared/api/auth.ts';
import { ok } from '../../../_shared/api/respond.ts';
import { validateBody, validateUuid } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { UpdateMemberRoleBodySchema } from '@lorekit/schemas/member';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleChangeRole(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const idV = validateUuid(params.userId ?? '', cors);
  if (!idV.ok) return idV.response;
  const bodyV = await validateBody(req, UpdateMemberRoleBodySchema, cors);
  if (!bodyV.ok) return bodyV.response;
  span.setAttributes({ 'lorekit.operation': 'members.change_role', 'lorekit.org_slug': params.slug ?? '', 'lorekit.target_user': idV.data });
  const tracedDb = createTracedClient(db, span);
  const { error } = await tracedDb.rpc('lorekit_org_member_role', { p_slug: params.slug, p_target_user_id: idV.data, p_role: bodyV.data.role });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return ok({ slug: params.slug, userId: idV.data, role: bodyV.data.role }, cors);
}
