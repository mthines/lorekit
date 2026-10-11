import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { forbidden, ok } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { dryRun } from '../../_shared/api/respond.ts';
import { SetJudgmentKeyBodySchema } from '../../_shared/schemas/judgment.ts';
import { JUDGMENT_PROVIDER } from '../../_shared/judgment/judgment.ts';
import { setJudgmentKey, getJudgmentKeyStatus, deleteJudgmentKey } from '../../_shared/judgment/judgment-keys.ts';

/**
 * `GET|POST|DELETE /memories/judgment-key` — manage the caller's OWN TypeSafe
 * (Jev) BYOK key for `GET /memories/relevant` reranking.
 *
 * All three routes are `requires: 'jwt'` (see `memories/index.ts`): this is a
 * personal secret, not tenant data an `lk_*` API token should ever reach on a
 * user's behalf. The user id is therefore always `auth.userId` off the
 * verified JWT — never anything a request body/query could name (AC-6).
 *
 * The decrypted key itself never appears in any response these handlers
 * build; the storage and retrieval that DOES touch it lives entirely in
 * `_shared/judgment/judgment-keys.ts`.
 */

export async function handleJudgmentKeyStatus(
  _req: Request, auth: AuthContext, _db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  if (!auth.userId) return forbidden('This endpoint requires a signed-in user', cors);
  const status = await getJudgmentKeyStatus(auth.userId, JUDGMENT_PROVIDER, span);
  span.setAttributes({ 'lorekit.operation': 'judgment_key.status', 'lorekit.judgment.configured': status.configured });
  return ok(status, cors);
}

export async function handleJudgmentKeySet(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  if (!auth.userId) return forbidden('This endpoint requires a signed-in user', cors);
  const userId = auth.userId;

  const v = await validateBody(req, SetJudgmentKeyBodySchema, cors);
  if (!v.ok) return v.response;
  const { api_key, provider } = v.data;

  span.setAttributes({ 'lorekit.operation': 'judgment_key.set', 'lorekit.judgment.provider': provider });

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const { last4 } = await setJudgmentKey(userId, api_key, provider, span);
  await recordAudit(db, { action: 'judgment_key.set', resourceType: 'judgment_provider_key', target: provider, metadata: { provider, last4 } }, auditUserId(auth), span);
  return ok({ configured: true, last4 }, cors);
}

export async function handleJudgmentKeyDelete(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  if (!auth.userId) return forbidden('This endpoint requires a signed-in user', cors);
  const userId = auth.userId;

  span.setAttributes({ 'lorekit.operation': 'judgment_key.delete', 'lorekit.judgment.provider': JUDGMENT_PROVIDER });

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const deleted = await deleteJudgmentKey(userId, JUDGMENT_PROVIDER, span);
  if (deleted) {
    await recordAudit(db, { action: 'judgment_key.delete', resourceType: 'judgment_provider_key', target: JUDGMENT_PROVIDER }, auditUserId(auth), span);
  }
  return ok({ deleted }, cors);
}
