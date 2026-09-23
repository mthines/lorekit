/**
 * TypeSafe (Jev) judgment — the Vault-backed BYOK key store.
 *
 * The ONLY module that ever reads a decrypted judgment key
 * (`loadJudgmentKey`) or writes one to Vault (`setJudgmentKey`). Every
 * function here talks to Postgres through its OWN `serviceClient()`
 * (`_shared/db/service-client.ts`), never the request's own `db` — the
 * `lorekit_judgment_key_*` RPCs are granted to `service_role` ONLY
 * (`supabase/migrations/00112_judgment_provider_keys.sql`), so a JWT-scoped
 * client could not call them even if handed one.
 *
 * Deliberately not wrapped by the automatic per-query tracing helper in
 * `_shared/telemetry/otel.ts`: its query-builder interpolates filter/argument
 * VALUES into the span name and query text — exactly the mechanism that would
 * put a caller-supplied key argument into an exported span. A
 * plain `db.rpc(...)` call on the raw client produces no span attributes at
 * all, which is the simplest way to guarantee the key can never leak through
 * telemetry (AC-18) — not "redact carefully", but "never construct the
 * attribute in the first place". The few spans this module DOES create name
 * only non-secret fields: `provider`, `status`, `version`, `last4` (the whole
 * point of a last-4 display), `calls_total`.
 *
 * `p_user_id` on every RPC call comes from the caller's own resolved auth
 * context (`auth.userId` / `actorUserId(auth)`), NEVER from request
 * body/query/params — see `handlers/judgment-key.ts` and
 * `handlers/relevant.ts`, both asserted by AC-6's source scan.
 */
import { serviceClient } from '../db/service-client.ts';
import type { Span } from '../telemetry/otel.ts';
import { JUDGMENT_PROVIDER } from './judgment.ts';
import type { JudgmentKeyStatusResponse } from '../schemas/judgment.ts';

/** A resolved key, ready to send to TypeSafe — never logged, never spanned. */
export interface LoadedJudgmentKey {
  apiKey: string;
  /** The row's version at load time — threaded through to `recordJudgmentKeyCall`
   *  so a rotate between load and record cannot mis-flip the NEW key's status. */
  version: number;
}

/**
 * Decrypt the caller's own judgment key for the ONE call site that sends it
 * over the wire (`judgment-client.ts`'s `judgeCandidates`). `null` for every
 * reason a caller must fail closed to the baseline path (D5): not configured,
 * Vault unavailable, or the RPC itself erroring — this function never throws.
 */
export async function loadJudgmentKey(
  userId: string,
  provider: string,
  span: Span,
): Promise<LoadedJudgmentKey | null> {
  const keySpan = span.child('lorekit.judgment.key_store', { 'lorekit.judgment.operation': 'get', 'lorekit.judgment.provider': provider });
  try {
    const db = serviceClient();
    const { data, error } = await db.rpc('lorekit_judgment_key_get', { p_user_id: userId, p_provider: provider });
    if (error) { keySpan.error(`RpcError: ${error.message}`); return null; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { keySpan.setAttributes({ 'lorekit.judgment.found': false }); return null; }
    keySpan.setAttributes({ 'lorekit.judgment.found': true, 'lorekit.judgment.version': row.version });
    return { apiKey: row.decrypted_secret, version: row.version };
  } catch (err) {
    keySpan.error((err as Error).name);
    return null;
  } finally {
    keySpan.end();
  }
}

/**
 * Store a brand-new key, or rotate the existing one (D12). Returns the new
 * `version` and the key's `last4` for the caller to confirm back to the user.
 * Throws on genuine failure (missing Vault, DB error) — this is the
 * user-initiated write path, so unlike the read side there is a real error to
 * surface rather than a baseline to fail closed to.
 */
export async function setJudgmentKey(
  userId: string,
  apiKey: string,
  provider: string,
  span: Span,
): Promise<{ version: number; last4: string }> {
  const last4 = apiKey.slice(-4);
  const keySpan = span.child('lorekit.judgment.key_store', { 'lorekit.judgment.operation': 'set', 'lorekit.judgment.provider': provider });
  try {
    const db = serviceClient();
    const { data, error } = await db
      .rpc('lorekit_judgment_key_set', { p_user_id: userId, p_provider: provider, p_api_key: apiKey, p_last4: last4 })
      .single();
    if (error) { keySpan.error(`RpcError: ${error.message}`); throw error; }
    keySpan.setAttributes({ 'lorekit.judgment.version': data.version, 'lorekit.judgment.last4': last4 });
    return { version: data.version, last4 };
  } finally {
    keySpan.end();
  }
}

/** Status only — never joins Vault, so the decrypted value cannot leak through
 *  a settings panel poll. Absent row maps to `configured: false`. */
export async function getJudgmentKeyStatus(
  userId: string,
  provider: string,
  span: Span,
): Promise<JudgmentKeyStatusResponse> {
  const keySpan = span.child('lorekit.judgment.key_store', { 'lorekit.judgment.operation': 'status', 'lorekit.judgment.provider': provider });
  try {
    const db = serviceClient();
    const { data, error } = await db.rpc('lorekit_judgment_key_status', { p_user_id: userId, p_provider: provider });
    if (error) { keySpan.error(`RpcError: ${error.message}`); throw error; }
    const row = Array.isArray(data) ? data[0] : data;
    keySpan.setAttributes({ 'lorekit.judgment.found': !!row });
    if (!row) return { configured: false, provider: null, last4: null, status: null, calls_total: null, created_at: null };
    return {
      configured: true,
      provider: provider as JudgmentKeyStatusResponse['provider'],
      last4: row.last4,
      status: row.status as JudgmentKeyStatusResponse['status'],
      calls_total: row.calls_total,
      created_at: row.created_at,
    };
  } finally {
    keySpan.end();
  }
}

/** Remove the caller's own key. `false` when nothing was configured — a no-op,
 *  not an error. The underlying Vault secret is removed by the migration's
 *  `AFTER DELETE` trigger, not by this function. */
export async function deleteJudgmentKey(userId: string, provider: string, span: Span): Promise<boolean> {
  const keySpan = span.child('lorekit.judgment.key_store', { 'lorekit.judgment.operation': 'delete', 'lorekit.judgment.provider': provider });
  try {
    const db = serviceClient();
    const { data, error } = await db.rpc('lorekit_judgment_key_delete', { p_user_id: userId, p_provider: provider }).single();
    if (error) { keySpan.error(`RpcError: ${error.message}`); throw error; }
    keySpan.setAttributes({ 'lorekit.judgment.deleted': !!data });
    return Boolean(data);
  } finally {
    keySpan.end();
  }
}

/**
 * Count one call attempt and, version-guarded, flip active/rejected from the
 * classified outcome. Best-effort: a failure here must not affect the
 * response `judgeCandidates` already computed, so this never throws.
 */
export async function recordJudgmentKeyCall(
  userId: string,
  provider: string,
  version: number,
  outcome: string,
  span: Span,
): Promise<void> {
  const keySpan = span.child('lorekit.judgment.key_store', {
    'lorekit.judgment.operation': 'record_call',
    'lorekit.judgment.provider': provider,
    'lorekit.judgment.version': version,
  });
  try {
    const db = serviceClient();
    const { error } = await db.rpc('lorekit_judgment_key_record_call', {
      p_user_id: userId,
      p_provider: provider,
      p_version: version,
      p_outcome: outcome,
    });
    if (error) keySpan.error(`RpcError: ${error.message}`);
  } catch (err) {
    keySpan.error((err as Error).name);
  } finally {
    keySpan.end();
  }
}

/** Re-exported so callers need one import for both the store and the provider
 *  constant they almost always pass alongside it. */
export { JUDGMENT_PROVIDER };
