import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../../_shared/api/auth.ts';
import { noContent } from '../../../_shared/api/respond.ts';
import { validateUuid } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleRevokeInvite(req: Request, auth: AuthContext, db: DbClient, span: Span, params: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const idV = validateUuid(params.inviteId ?? '', cors);
  if (!idV.ok) return idV.response;
  span.setAttributes({ 'lorekit.operation': 'invites.revoke', 'lorekit.org_slug': params.slug ?? '', 'lorekit.invite_id': idV.data });
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { error } = await tracedDb.rpc('lorekit_org_invite_revoke', { p_invite_id: idV.data });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  return noContent(cors);
}
