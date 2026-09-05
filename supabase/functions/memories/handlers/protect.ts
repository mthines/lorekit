import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { forbidden, ok, dryRun } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { ProtectBodySchema } from '../../_shared/schemas/retention.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

/**
 * POST /protect — mark or unmark a lesson as protected from every grooming
 * candidate set (`lorekit_groom_candidates` excludes `protected` rows
 * unconditionally, regardless of policy). Mirrors the MCP `memory.protect`
 * tool: same `lorekit_memory_protect` RPC, same audit-only-on-change rule.
 */
export async function handleProtect(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  if (!auth.userId) {
    return forbidden('memory.protect requires a user-scoped credential (service-role tokens have no owner)', cors);
  }
  const userId = auth.userId;

  const v = await validateBody(req, ProtectBodySchema, cors);
  if (!v.ok) return v.response;
  const { scope, key, protected: isProtected } = v.data;

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key, 'lorekit.protect.value': isProtected });

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<boolean>('lorekit_memory_protect', { p_user_id: userId, p_scope: scope, p_key: key, p_protected: isProtected })
    .single();
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const changed = Boolean(data);
  span.setAttributes({ 'lorekit.result.changed': changed });
  if (changed) {
    await recordAudit(
      db,
      { action: 'memory.protect', resourceType: 'memory', target: key, metadata: { scope, key, protected: isProtected } },
      auditUserId(auth),
      span,
    );
  }
  return ok({ protected: isProtected }, cors);
}
