/**
 * The option set behind Settings → Organization → "Bind a scope" — the pure
 * half of `BindScopeForm`.
 *
 * The form used to read its suggestions with a direct `memories` select
 * (`order by scope limit 500`, deduped to at most 100, 20 rendered). That is a
 * prefix of the ALPHABET, not of the catalog: an account with a few thousand
 * memories only ever saw its `branch::a…` scopes, and typing a scope that
 * sorted later filtered a list it had never been loaded into, so an existing
 * scope "did not exist". The catalog now comes whole from `GET /memories/scopes`
 * (aggregated in Postgres, one row per scope), and searching it is the
 * `Combobox`'s job — so this module only decides WHAT is offered.
 */

import { scopeType, type ScopePrefix } from '@/lib/scope';
import { validateScopeBindingPattern } from '@/lib/scope-bindings-validate';
import { scopePatternOptions } from '@/lib/token-scoping';

export interface BindableScopeOption {
  /** The exact string `bindScope` receives — a canonical scope or an owner wildcard. */
  value: string;
  /** The short, recognisable part: the last `::` segment, or the whole pattern for a wildcard. */
  label: string;
  /** The full scope, so a search for any part of it — owner, repo, branch — matches. */
  hint: string;
  /** Drives the row icon. A wildcard takes its prefix's type (`repo::acme/*` → `repo`). */
  type: ScopePrefix;
}


/**
 * Every scope and owner wildcard the org could bind, minus what it already has.
 *
 * - **Wildcards come from the same derivation the API-key picker uses**
 *   (`scopePatternOptions`): `repo::acme/a` + `repo::acme/b` imply
 *   `repo::acme/*`. Both pickers validate against one pattern grammar, which is
 *   also the grammar `lorekit_scope_bind` enforces (00111 reuses 00068's shape
 *   check), so the two cannot offer different wildcards for the same catalog.
 * - **Already-bound values are dropped**, compared on the stored (lowercased)
 *   form — offering a scope the org already has invites a duplicate-bind error.
 * - **Nothing the bind would refuse is offered.** Every value passes
 *   `validateScopeBindingPattern`; a malformed row from the catalog is skipped
 *   rather than surfaced as a choice that fails on submit.
 * - **Order is wildcards first, then exact scopes, each alphabetical** —
 *   `scopePatternOptions`' order. A stable order beats the catalog's
 *   count-desc order, which reshuffles between visits as agents write.
 */
export function bindableScopeOptions(
  catalog: readonly string[],
  bound: readonly string[],
): BindableScopeOption[] {
  const boundSet = normalisedSet(bound);
  const options: BindableScopeOption[] = [];

  for (const pattern of scopePatternOptions(catalog)) {
    const validated = validateScopeBindingPattern(pattern);
    if (!validated.ok) continue;
    const value = validated.normalized;
    if (boundSet.has(value)) continue;

    const isWildcard = value.endsWith('*');
    options.push({
      value,
      label: isWildcard ? value : lastSegment(value),
      hint: isWildcard ? wildcardHint(value) : value,
      type: scopeType(value),
    });
  }

  return options;
}

/**
 * The "use what you typed" row for the combobox's `creatable` prop: a valid
 * binding pattern, normalised the way it will be stored, or `null`.
 *
 * This is how a scope with no memories yet — or a wildcard the catalog does
 * not imply, such as `branch::acme/api::*` — stays bindable now that the free
 * text input is gone. `null` for anything `validateScopeBindingPattern` rejects,
 * so a row that would fail on submit is never offered — and `null` for a value
 * the org already has. The combobox only suppresses a typed row that duplicates
 * an OFFERED option, and a bound scope is deliberately not offered, so without
 * `bound` here typing it would bring it straight back.
 */
export function creatableBindingScope(
  query: string,
  bound: readonly string[] = [],
): BindableScopeOption | null {
  const validated = validateScopeBindingPattern(query);
  if (!validated.ok) return null;
  const value = validated.normalized;
  if (normalisedSet(bound).has(value)) return null;
  return { value, label: value, hint: 'use this scope', type: scopeType(value) };
}

/** Bindings are stored trimmed and lowercased, so compare in that form. */
function normalisedSet(scopes: readonly string[]): Set<string> {
  return new Set(scopes.map((s) => s.trim().toLowerCase()));
}

/**
 * What a wildcard binding actually covers, in words.
 *
 * A binding matches by literal prefix (00111: `p_scope like 'repo::acme/%'`),
 * so `repo::acme/*` covers acme's REPO scopes and none of its branch scopes —
 * which is where most agent lore is written. "Every scope under this owner"
 * would leave an admin believing branch lore is shared when it stays personal,
 * so the hint names the scope type it is limited to.
 *
 * `repo::acme/*` → `every repo scope under acme`, `branch::acme/*` →
 * `every branch scope under acme`, `project::*` → `every project scope`.
 */
function wildcardHint(pattern: string): string {
  const type = scopeType(pattern);
  const owner = pattern.slice(pattern.indexOf('::') + 2, -1).replace(/(\/|::)$/, '');
  return owner ? `every ${type} scope under ${owner}` : `every ${type} scope`;
}

/** `repo::acme/api` → `acme/api`, `branch::acme/api::main` → `main`, `global` → `global`. */
function lastSegment(scope: string): string {
  return scope.split('::').pop() ?? scope;
}
