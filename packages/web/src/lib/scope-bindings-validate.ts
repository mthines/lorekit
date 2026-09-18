/**
 * Web-side validation for a scope-binding pattern — the single shared home for
 * the client-side gate the server action (`bindScope`) and the dashboard form
 * (`BindScopeForm`) both consume, so the two cannot drift apart.
 *
 * A binding pattern is one of two shapes:
 *   - an owner WILDCARD (`repo::owner/*`, `branch::owner/repo::*`), validated
 *     against `ApiKeyScopePatternSchema` — the SAME grammar an API token's
 *     scope allowlist uses (`@lorekit/schemas/api-key`). Reused verbatim, never
 *     forked: one wildcard authority for the whole app.
 *   - an EXACT scope, which must ALSO pass full canonical `ScopeSchema`
 *     validation (`@lorekit/schemas/scope`) — a plain `ApiKeyScopePatternSchema`
 *     pass is shape-only and would accept `notaprefix::x`, which is not a real
 *     scope prefix.
 *
 * This is a CLIENT-SIDE convenience gate only. The authority remains
 * `lorekit_scope_bind`'s own SQL-side check (migration 00111), which every
 * caller — including one that bypasses this helper entirely — still goes
 * through.
 */

import { ApiKeyScopePatternSchema } from '@lorekit/schemas/api-key';
import { ScopeSchema } from '@lorekit/schemas/scope';

export type ScopeBindingValidationResult = { ok: true; normalized: string } | { ok: false; error: string };

/**
 * Validate and normalize a scope-binding pattern for submission to
 * `lorekit_scope_bind`. Trims and lowercases first, since that is how the
 * value is stored (`bindScope`/`unbindScope` already normalize this way).
 */
export function validateScopeBindingPattern(raw: string): ScopeBindingValidationResult {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return { ok: false, error: 'Scope is required' };
  }

  if (trimmed.endsWith('*')) {
    const result = ApiKeyScopePatternSchema.safeParse(trimmed);
    if (!result.success) {
      return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid scope pattern' };
    }
    return { ok: true, normalized: result.data };
  }

  const result = ScopeSchema.safeParse(trimmed);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid scope' };
  }
  return { ok: true, normalized: result.data };
}
