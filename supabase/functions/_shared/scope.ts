/**
 * Canonical scope validation — shared across Edge Functions.
 * Mirrors packages/mcp-core/src/scope.ts for the Deno runtime.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';
const VALID_PREFIXES = new Set<string>(['global', 'project', 'repo', 'branch']);

/**
 * Sentinel for caller-supplied input that is structurally invalid (bad scope
 * format, unknown prefix, etc.). Handlers that catch this should NOT mark the
 * span as ERROR — the service behaved correctly; the caller sent bad input.
 * Mirrors the OTel semantic-convention rule that server spans are ERROR only
 * for server-side faults, not 4xx client errors.
 */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

export function validateScope(raw: string): string {
  if (!raw) throw new UserInputError('scope must be a non-empty string');
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new UserInputError(`Invalid scope "${raw}": use "::" as the separator, not ":"`);
  }
  const normalized = raw.toLowerCase().trim();
  if (normalized === 'global') return 'global';
  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) throw new UserInputError(`Invalid scope "${raw}": unknown scope type`);
  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  if (!VALID_PREFIXES.has(prefix)) throw new UserInputError(`Invalid scope prefix "${prefix}"`);
  // SECURITY: a validated scope is interpolated into a PostgREST `.or()` filter
  // by the search handler (`scope.in.("<scope>")`), where `"` `,` `(` `)` are
  // structural. A canonical scope only ever uses word chars plus `. : / -`, so
  // reject anything else — otherwise `project::a",value.not.is.null` would break
  // out of the quoted filter value. (This mirror is intentionally lighter than
  // packages/mcp-core/src/scope.ts, so this guard must live here in its own right.)
  if (!/^[\w.:/-]+$/.test(normalized)) {
    throw new UserInputError(`Invalid scope "${raw}": contains unsupported characters`);
  }
  return normalized;
}

/**
 * Validate a caller-supplied scope FILTER, and return it unchanged.
 *
 * Three properties, and the third is the surprising one:
 *
 * 1. THROWS `UserInputError` on an ungrammatical scope, so the handler can
 *    answer 400. A scope filter IS the question being asked; keeping a
 *    malformed one and matching nothing answers a different question and calls
 *    it an empty result. This is the rule `GET /memories/read-activity` already
 *    follows and `memories/CLAUDE.md` states outright.
 *
 * 2. `undefined` in, `undefined` out — an absent filter is not an error.
 *
 * 2b. REJECTS SURROUNDING WHITESPACE. `validateScope` trims before it checks,
 *    so `" global"` is grammatical to it — but this returns the caller's own
 *    string, and `.eq('scope', ' global')` matches nothing. That is exactly the
 *    200-with-an-empty-page this whole change removes, so a padded filter is
 *    named as bad input instead. Trimming it silently would rewrite the
 *    question the caller asked, which property 3 forbids.
 *
 * 3. DOES NOT NORMALISE. `validateScope` lowercases, and this deliberately
 *    discards that result and returns the caller's own string. The REST write
 *    path does NOT normalise — `CreateMemoryBodySchema` overrides the
 *    normalising `ScopeSchema` with `RawScopeSchema` and `handlers/create.ts`
 *    passes `body.scope` through verbatim, with no `lower(scope)` anywhere in
 *    the migrations. So `memories.scope` legitimately holds mixed-case values,
 *    and lowercasing a filter here would make those rows unmatchable by list —
 *    and, worse, undeletable by natural key. Reject-only keeps the exact-match
 *    contract writes actually established.
 *
 * If the write path is ever normalised, normalise here in the same change and
 * not before; the two halves have to move together or existing rows are
 * stranded.
 */
export function parseScopeFilter(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Before the grammar check, because the grammar check trims it away.
  if (raw !== raw.trim()) {
    throw new UserInputError(`Invalid scope "${raw}": remove the surrounding whitespace`);
  }
  validateScope(raw); // throws UserInputError; the normalised result is discarded on purpose
  return raw;
}

/**
 * The ceiling `usage_events.scope` is stored under (`usage_events_scope_len`,
 * migration 00058), mirroring `packages/mcp-core/src/scope.ts`.
 */
export const USAGE_SCOPE_MAX = 200;

/**
 * Validate a scope for TELEMETRY, never for authorization.
 *
 * HAND-MIRRORED from `packages/mcp-core/src/scope.ts`, NOT generated. This file
 * is deliberately excluded from `edge-parity.spec.ts`'s MIRRORS list because the
 * two `validateScope` BODIES differ (the edge copy is intentionally lighter —
 * see the note inside it), so a whole-file comparison would be permanently red.
 * `safeValidateScope` itself is identical in both trees by construction: it is
 * a total wrapper that delegates every grammar decision to whichever
 * `validateScope` is in scope, so the intentional body difference propagates
 * rather than being duplicated. Keep the two wrappers in step by hand.
 *
 * Rationale: `usage_events.scope` is a dimension recorded alongside the
 * operation it measures, and a telemetry dimension must never fail the call it
 * is measuring (the 00044/00054 posture). An absent, non-string or
 * ungrammatical scope degrades to `null` — recorded as unattributed.
 *
 * The STORAGE bound is part of that contract: `validateScope` bounds no
 * length, so a grammatical 201-char scope would trip `usage_events_scope_len`
 * (00058) inside `lorekit_record_usage_event`, whose `when others` handler
 * would drop the WHOLE event rather than just the scope. Clamping here is
 * `parseCorrelationId`'s posture against `usage_events_correlation_id_len`.
 * It lives on this wrapper only — `memories.scope` has no ceiling, so the
 * grammar itself must keep accepting longer values.
 *
 * Deliberately NOT used on the read side: `GET /memories/read-activity?scope=`
 * is a caller-supplied FILTER, and silently coercing a typo'd filter to "no
 * filter" would answer a different question than the one asked. That path uses
 * the throwing `validateScope` and 400s.
 */
export function safeValidateScope(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const normalized = validateScope(raw);
    return normalized.length > USAGE_SCOPE_MAX ? null : normalized;
  } catch {
    return null;
  }
}


