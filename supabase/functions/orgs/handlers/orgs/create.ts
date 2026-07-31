import type { AuthContext } from '../../../_shared/api/auth.ts';
import { created } from '../../../_shared/api/respond.ts';
import { validateBody } from '../../../_shared/api/validate.ts';
import { createTracedClient } from '../../../_shared/otel.ts';
import type { Span } from '../../../_shared/otel.ts';
import { CreateOrgBodySchema } from '../../../_shared/schemas/org.ts';
import { translateDbError } from '../../../_shared/api/errors.ts';
import { auditUserId } from '../../../_shared/api/auth.ts';
import { recordAudit } from '../../../_shared/audit.ts';
import type { DbClient } from '../../../_shared/api/auth.ts';

export async function handleCreateOrg(req: Request, auth: AuthContext, db: DbClient, span: Span, _p: Record<string,string>, cors: Record<string,string>): Promise<Response> {
  const v = await validateBody(req, CreateOrgBodySchema, cors);
  if (!v.ok) return v.response;
  span.setAttributes({ 'lorekit.operation': 'orgs.create', 'lorekit.org_slug': v.data.slug });
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_org_create', { p_slug: v.data.slug, p_name: v.data.name });
  if (error) { const m = translateDbError(error); if (m) return m.toResponse(cors); span.error(error.message); throw error; }
  // `lorekit_org_create` returns the new org's uuid and nothing else.
  const orgId = data as unknown as string;

  // Audit AFTER the RPC succeeded. Same shape as the dashboard's `createOrg`
  // (packages/web/src/lib/orgs.ts) so the REST and dashboard surfaces produce
  // comparable rows.
  await recordAudit(
    db,
    {
      action: 'org.create',
      resourceType: 'org',
      resourceId: orgId,
      target: v.data.name,
      metadata: { slug: v.data.slug },
    },
    auditUserId(auth),
  );

  // Read the row back so the 201 body is an Org object, which is what this
  // route's OpenAPI response schema (`OrgResponseSchema`) has always promised
  // and what every other org route returns. The RPC yields only a bare uuid,
  // so returning `data` directly shipped a JSON string where callers expect
  // `{ id, slug, name, created_at }` — a contract violation that survived
  // unnoticed because the orgs smoke suite needs a JWT credential CI does not
  // set. `created_at` is server-generated, so it can only come from a read.
  const { data: org, error: readErr } = await tracedDb
    .from<{ id: string; slug: string; name: string; created_at: string }>('orgs')
    .select('id,slug,name,created_at')
    .eq('id', orgId)
    .maybeSingle();
  if (readErr) { span.error(readErr.message); throw readErr; }

  // The org exists — the RPC just created it and made the caller its owner, so
  // the read is RLS-visible. Fall back to the ids we already hold rather than
  // failing a request whose write succeeded.
  return created(org ?? { id: orgId, slug: v.data.slug, name: v.data.name }, cors);
}
