/**
 * Canonical scope format:
 *   global
 *   project::{name}
 *   repo::{owner}/{repo}
 *   branch::{owner}/{repo}::{branch}
 *
 * The `::` double-colon is the ONLY valid segment separator.
 * Single colon, slash, or dash as separators are rejected with a validation error.
 */

import { z } from 'zod';

const VALID_PREFIXES = ['global', 'project', 'repo', 'branch'] as const;
export type ScopePrefix = (typeof VALID_PREFIXES)[number];

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValidationError';
  }
}

/**
 * Validate a canonical scope string. Throws ScopeValidationError if invalid.
 * Returns the normalized (lowercased) scope string.
 */
export function validateScope(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new ScopeValidationError('scope must be a non-empty string');
  }

  // Reject the common mistake of using single `:` or no separator with a keyword
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new ScopeValidationError(
      `Invalid scope "${raw}": use "::" as the separator, not ":". ` +
        `Example: "repo::${raw.split(':')[1] ?? 'owner/repo'}"`,
    );
  }

  const normalized = raw.toLowerCase().trim();

  if (normalized === 'global') {
    return 'global';
  }

  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) {
    throw new ScopeValidationError(
      `Invalid scope "${raw}": unknown scope type. Valid types: ${VALID_PREFIXES.join(', ')}`,
    );
  }

  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  const rest = normalized.slice(sepIdx + 2);

  if (!VALID_PREFIXES.includes(prefix)) {
    throw new ScopeValidationError(
      `Invalid scope prefix "${prefix}". Valid prefixes: ${VALID_PREFIXES.join(', ')}`,
    );
  }

  if (!rest) {
    throw new ScopeValidationError(`Scope "${raw}" has an empty value after the prefix`);
  }

  if (prefix === 'project') {
    if (!rest.match(/^[\w.-]+$/)) {
      throw new ScopeValidationError(
        `Invalid project scope "${raw}": project name must be alphanumeric with dots and dashes`,
      );
    }
  }

  if (prefix === 'repo') {
    if (!rest.match(/^[\w.-]+\/[\w.-]+$/)) {
      throw new ScopeValidationError(
        `Invalid repo scope "${raw}": expected format "repo::owner/repo-name"`,
      );
    }
  }

  if (prefix === 'branch') {
    const parts = rest.split('::');
    // The branch-name segment allows `/` (e.g. "feat/x") but is otherwise
    // restricted to the canonical charset — crucially it must NOT admit `"` or
    // `,`, which are structural in the PostgREST `scope.in.("...")` filter the
    // search tool builds from validated scopes. Leaving it merely "non-empty"
    // let `branch::o/r::a",value.not.is.null` break out of that filter.
    if (
      parts.length !== 2 ||
      !parts[0]?.match(/^[\w.-]+\/[\w.-]+$/) ||
      !parts[1]?.match(/^[\w./-]+$/)
    ) {
      throw new ScopeValidationError(
        `Invalid branch scope "${raw}": expected format "branch::owner/repo::branch-name" ` +
          `(branch name may contain only letters, digits, "._-/")`,
      );
    }
  }

  return normalized;
}

/**
 * The ceiling `usage_events.scope` is stored under (`usage_events_scope_len`,
 * migration 00058). Declared here, next to the validator that enforces it,
 * for the same reason `CORRELATION_ID_MAX` sits next to `parseCorrelationId`.
 */
export const USAGE_SCOPE_MAX = 200;

/**
 * Validate a scope for TELEMETRY, never for authorization.
 *
 * `validateScope` is the one canonical grammar and stays that way — this is a
 * thin total wrapper over it, not a second, laxer validator. The difference is
 * only in the failure mode: `usage_events.scope` is a dimension recorded
 * alongside the operation it measures, and a telemetry dimension must never
 * fail the call it is measuring (the 00044/00054 posture). So an absent,
 * non-string or ungrammatical scope degrades to `null` — recorded as
 * unattributed — instead of throwing.
 *
 * The one thing this wrapper adds on top of the grammar is the STORAGE bound.
 * `validateScope` bounds no length — a `project::`/`branch::` value is only
 * charset-restricted — so a perfectly grammatical 201-char scope would reach
 * `usage_events` and trip `usage_events_scope_len`. That CHECK violation is
 * raised inside `lorekit_record_usage_event`, whose `when others` handler
 * swallows it and returns null, so the WHOLE usage event would be lost rather
 * than just its scope dimension. Clamping here — exactly what
 * `parseCorrelationId` does against `usage_events_correlation_id_len` — keeps
 * the failure proportional: an over-long scope is recorded as unattributed and
 * the event itself still lands. The bound belongs on this wrapper and NOT on
 * `validateScope`, because `memories.scope` has no such ceiling and the
 * `?scope=` read filter must keep accepting every scope a memory can be
 * written under.
 *
 * Deliberately NOT used on the read side: `GET /memories/read-activity?scope=`
 * is a caller-supplied FILTER, and silently coercing a typo'd filter to "no
 * filter" would answer a different question than the one asked. That path uses
 * the throwing `validateScope` and 400s, matching the `?correlation_id=`
 * precedent.
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

/**
 * Return the scope type for use as a low-cardinality telemetry attribute.
 */
export function scopeType(scope: string): ScopePrefix {
  if (scope === 'global') return 'global';
  const prefix = scope.split('::')[0] as ScopePrefix;
  return prefix;
}

/**
 * Expand a search scope that may include an owner-level wildcard.
 * "repo::mthines/*" → SQL LIKE pattern "repo::mthines/%"
 * Returns { exact: string } or { like: string }.
 */
export type ScopeFilter =
  | { exact: string }
  | { like: string };

export function expandScopeForSearch(raw: string): ScopeFilter {
  const normalized = raw.toLowerCase().trim();
  // Owner wildcard: repo::owner/* or project::*
  if (normalized.endsWith('/*') || normalized.endsWith('::*')) {
    const base = normalized.slice(0, -1); // drop the trailing '*', keep '/' or '::'
    // SECURITY: `base` is interpolated verbatim into a PostgREST `.or()` filter
    // string as `scope.like.<base>%`, where `,` `(` `)` are structural grammar.
    // A canonical scope only ever contains [a-z0-9._:/-] (see validateScope), so
    // reject anything else — otherwise a crafted wildcard like
    // `a,value.not.is.null,scope.like.z::*` would inject extra OR predicates into
    // the filter tree. The exact-scope branch below is already safe by
    // construction because validateScope's charset admits no quotes/commas.
    if (!/^[a-z0-9._:/-]+$/.test(base)) {
      throw new ScopeValidationError(
        `Invalid wildcard scope "${raw}": a wildcard scope may contain only ` +
          `[a-z0-9._:/-] before the trailing "*"`,
      );
    }
    // Escape the LIKE single-character wildcard `_` in the literal owner prefix
    // so `repo::my_org/*` stays owner-exact instead of also matching
    // `repo::myXorg/*`. (`%` and `\` can't occur — the charset above excludes
    // them.) `\` is LIKE's default escape character.
    return { like: base.replace(/_/g, '\\_') + '%' };
  }
  return { exact: validateScope(raw) };
}

/**
 * Zod schema for a canonical scope string (validates at the Zod layer).
 */
export const ScopeSchema = z.string().transform((val, ctx) => {
  try {
    return validateScope(val);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

/**
 * The `scope::key` REFERENCE grammar — one lesson named as one string.
 *
 * WHY A STRING AND NOT `{ scope, key }`. This exists for `memory.write`'s
 * `cited` array, and a citation is the agent ECHOING BACK an identifier it was
 * already handed: the SessionStart hook injects lessons labelled `scope::key`,
 * `lorekit list` prints them that way, and `lorekit show`/`protect` already
 * take one as a positional. Making the citation a different shape from the
 * label the agent read would put a translation step between "I applied this"
 * and saying so, which is the step that does not survive contact with a model.
 *
 * WHY THE SPLIT IS NOT `lastIndexOf('::')` — nor `indexOf`. A scope may itself
 * contain `::` (`branch::owner/repo::feat/x`) and a key may contain it too
 * (`global::my::key`), so neither end is a safe anchor. The split is decided by
 * the GRAMMAR instead: walk the `::` positions left to right and take the FIRST
 * one whose left half is a legal scope. `branch::owner/repo::feat/x::my-key`
 * splits after `feat/x` because `branch::owner/repo` is not a legal scope
 * (a branch scope needs three segments), while `global::my::key` splits at the
 * first `::` because `global` is. Ambiguity is therefore resolved toward the
 * SHORTEST valid scope, which is the same rule the CLI's `resolveScopeArg`
 * applies — the three copies are paired by `memory-ref.spec.ts`.
 *
 * WHY IT DOES NOT CALL `validateScope`. The two runtimes' copies of that
 * function are deliberately DIFFERENT strengths — the edge mirror is documented
 * as "intentionally lighter" and omits the per-prefix shape rules, so
 * `branch::owner/repo` is legal there and not here. A split decided by a
 * predicate that answers differently on the two runtimes would put the SAME
 * citation under two different lessons depending on which surface received it.
 * `isReferenceScope` below is therefore self-contained and byte-identical in
 * both copies, and it is used ONLY to decide where the string divides — never
 * to authorize, normalise, or stand in for `validateScope` at a boundary.
 */
const REF_OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

function isReferenceScope(raw: string): boolean {
  const s = raw.toLowerCase();
  if (s === 'global') return true;
  const sep = s.indexOf('::');
  if (sep === -1) return false;
  const prefix = s.slice(0, sep);
  const rest = s.slice(sep + 2);
  if (!rest) return false;
  if (prefix === 'project') return /^[\w.-]+$/.test(rest);
  if (prefix === 'repo') return REF_OWNER_REPO.test(rest);
  if (prefix === 'branch') {
    const parts = rest.split('::');
    return parts.length === 2 && REF_OWNER_REPO.test(parts[0]) && /^[\w./-]+$/.test(parts[1]);
  }
  return false;
}

/**
 * Split a `scope::key` reference.
 *
 * THE SCOPE IS RETURNED VERBATIM, not lowercased. `memories.scope` is stored as
 * written on the REST path, so a reference is resolved against the stored text;
 * the grammar above is consulted for its VERDICT only. Same posture, same
 * reason, as `parseScopeFilter` — see `clusters.ts`/`utility.ts`.
 *
 * Total: returns `null` for anything that is not a reference, never throws.
 */
export interface MemoryRef {
  scope: string;
  key: string;
}

export function parseMemoryRef(raw: unknown): MemoryRef | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  for (let idx = s.indexOf('::'); idx !== -1; idx = s.indexOf('::', idx + 2)) {
    const scope = s.slice(0, idx).trim();
    const key = s.slice(idx + 2).trim();
    if (key && isReferenceScope(scope)) return { scope, key };
  }
  return null;
}

/**
 * The ceiling on how many `scope::key` references ONE call may name — shared
 * by `memory.write`'s `cited` field and `memory.read`'s batch `refs` field.
 *
 * For `cited`: a retrospective names the handful of lessons that actually
 * shaped the run; a list longer than this is a model dumping its whole
 * injected set, which is the opposite of the evidence this field exists to
 * collect. For `refs`: a batch read names the handful of lessons a run needs
 * next, not an unbounded fetch-everything. Both are TRUNCATED rather than
 * rejected past this cap, for the reason every telemetry dimension in this
 * codebase is: naming too many references must never fail the call it
 * accompanies.
 */
export const MEMORY_CITED_MAX = 32;

/**
 * Parse, validate, de-duplicate and cap a `scope::key` reference array —
 * `memory.write`'s `cited` field and `memory.read`'s batch `refs` field both
 * resolve through this one function (R3: no second reference parser).
 *
 * De-duplication is by the resolved `(scope, key)` pair rather than by the raw
 * string, so `global::x` and `  global::x  ` are one reference. It is
 * CASE-SENSITIVE on the scope for the same reason it already was on the key:
 * both consumers resolve a reference by VERBATIM comparison — `cited` joins
 * `m.scope = r.scope` (00107) and `refs` filters `.eq('scope', …)` — so
 * `Global::x` and `global::x` are two different addresses, not one lesson
 * spelled two ways. Folding them kept whichever came FIRST and dropped the
 * other; since the MCP write path stores scopes lowercased (`validateScope`),
 * the surviving mixed-case ref then resolved to nothing while the one that
 * would have resolved had already been discarded.
 *
 * Unparseable entries are DROPPED, not rejected: see `MEMORY_CITED_MAX`.
 */
export function parseMemoryRefs(raw: unknown): MemoryRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MemoryRef[] = [];
  for (const entry of raw) {
    const ref = parseMemoryRef(entry);
    if (!ref) continue;
    const id = `${ref.scope}\u0000${ref.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ref);
    if (out.length >= MEMORY_CITED_MAX) break;
  }
  return out;
}
