/**
 * The dashboard's model of API-key scoping — the pure half.
 *
 * A key can be narrowed along two axes (migration 00067): an allowlist of scope
 * patterns, and a tenancy (`all` / `personal` / `selected` orgs). This module
 * owns the decisions the UI needs and the DB does not care about: what the
 * picker offers, what the row badge says, and how the whole thing reads as a
 * sentence.
 *
 * Pure and co-located with a `.spec.ts`, like `token-permission.ts` next door —
 * `TokenManager.tsx` stays a view over it.
 *
 * The AUTHORITY for what a key reaches is the database
 * (`lorekit_api_token_scope_allowed`) and the edge
 * (`@lorekit/schemas/api-key`'s `scopeAllowedByKey`). Nothing here decides
 * access; it decides wording. Do not add a third matcher.
 */
import { ApiKeyScopePatternSchema } from '@lorekit/schemas/api-key';

export type OrgAccess = 'all' | 'personal' | 'selected';

/** A key's scoping as the dashboard reads it back off `api_tokens`. */
export interface TokenScoping {
  /** Allowlist of scope patterns. EMPTY = unrestricted. */
  scopes: string[];
  org_access: OrgAccess;
  /** Meaningful only under `selected`. */
  org_ids: string[];
}

/** The unrestricted default — what a key created before 00067 carries. */
export const UNSCOPED: TokenScoping = { scopes: [], org_access: 'all', org_ids: [] };

export interface OrgAccessTier {
  value: OrgAccess;
  label: string;
  desc: string;
}

/**
 * Single source of truth for the three tenancy choices — drives both the
 * "New token" cards and the row badge, so adding one is a single edit here
 * rather than parallel arrays. Same shape and same reasoning as
 * `PERMISSION_TIERS`.
 */
export const ORG_ACCESS_TIERS: readonly OrgAccessTier[] = [
  {
    value: 'all',
    label: 'All my orgs',
    desc: 'Personal memories plus every org you belong to',
  },
  {
    value: 'personal',
    label: 'Personal only',
    desc: 'Your own memories, no org memories',
  },
  {
    value: 'selected',
    label: 'Specific orgs',
    desc: 'Your own memories plus the orgs you pick',
  },
] as const;

/** Is this key restricted at all? Drives whether a badge renders. */
export function isScoped(scoping: TokenScoping): boolean {
  return scoping.scopes.length > 0 || scoping.org_access !== 'all';
}

/**
 * The scope half of the row badge, or `null` when there is nothing to say.
 *
 * A count, not the patterns: a token row is one line and three repo paths do
 * not fit it. The patterns themselves belong in the title text below, where
 * there is room to be exact.
 */
export function scopeBadgeLabel(scopes: string[]): string | null {
  if (scopes.length === 0) return null;
  return scopes.length === 1 ? '1 scope' : `${scopes.length} scopes`;
}

/**
 * The tenancy half of the row badge, or `null` under the unrestricted default.
 *
 * `null` for `all` rather than "all orgs": a badge that every unscoped key
 * carries is noise, and the row already means "unrestricted" by having no
 * badge at all.
 */
export function orgBadgeLabel(scoping: TokenScoping): string | null {
  if (scoping.org_access === 'all') return null;
  if (scoping.org_access === 'personal') return 'personal only';
  const n = scoping.org_ids.length;
  return n === 1 ? '1 org' : `${n} orgs`;
}

/**
 * The full scoping as one sentence, for the row's `title` and the review step
 * of the create form.
 *
 * Names the orgs where it can — a uuid tells the reader nothing — and falls
 * back to the count when a name is missing, which happens when the key points
 * at an org the viewer has since left. That is worth showing rather than
 * hiding: the key still carries it, and the RPC will refuse to re-save it.
 */
export function describeScoping(
  scoping: TokenScoping,
  orgNameById: Readonly<Record<string, string>> = {},
): string {
  if (!isScoped(scoping)) return 'Unrestricted — every scope and org you can reach.';

  const parts: string[] = [];

  parts.push(
    scoping.scopes.length === 0
      ? 'Any scope'
      : `Scopes: ${scoping.scopes.join(', ')}`,
  );

  if (scoping.org_access === 'personal') {
    parts.push('personal memories only');
  } else if (scoping.org_access === 'selected') {
    const named = scoping.org_ids.map((id) => orgNameById[id]).filter((n): n is string => !!n);
    parts.push(
      named.length === scoping.org_ids.length && named.length > 0
        ? `orgs: ${named.join(', ')}`
        : `${scoping.org_ids.length} org${scoping.org_ids.length === 1 ? '' : 's'}`,
    );
  }

  return `${parts.join(' · ')}.`;
}

/**
 * Turn the account's scope catalog into the patterns the picker offers.
 *
 * Two things beyond a pass-through:
 *
 * 1. **Owner wildcards are synthesised.** `repo::mthines/lorekit` and
 *    `repo::mthines/gw-tools` in the catalog imply `repo::mthines/*`, which is
 *    what a user scoping a CI token for one owner actually wants — and it keeps
 *    working when the next repo appears, which an exact list does not. A
 *    wildcard is only offered when the catalog has MORE THAN ONE scope under
 *    that owner, because `repo::solo/*` next to `repo::solo/only-repo` is two
 *    ways to say the same thing today and only one of them is honest about
 *    tomorrow.
 * 2. **Order is wildcards first, then exact scopes**, each alphabetically. The
 *    broader choice is the one a reader is usually looking for, and a stable
 *    order beats catalog order (which is by memory count and therefore moves
 *    under the user between visits).
 *
 * The catalog is whatever `GET /memories/scopes` returned, so it only ever
 * contains scopes that exist. A key can be scoped to a scope with no memories
 * yet — that is legitimate, and typing it is the escape hatch, which the picker
 * really does offer: `Combobox`'s `creatable` prop, wired to
 * {@link creatableScopePattern} below. This function only decides what is
 * OFFERED from the catalog.
 */
export function scopePatternOptions(catalog: readonly string[]): string[] {
  const exact = [...new Set(catalog)].sort();

  const perOwner = new Map<string, number>();
  for (const scope of exact) {
    const owner = ownerPrefixOf(scope);
    if (owner) perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
  }
  const wildcards = [...perOwner.entries()]
    .filter(([, count]) => count > 1)
    .map(([owner]) => `${owner}*`)
    .sort();

  return [...wildcards, ...exact];
}

/**
 * The wildcard-able prefix of a scope, or `null` when it has none.
 *
 * `repo::owner/name` → `repo::owner/`, `branch::owner/name::b` → `branch::owner/`,
 * `project::x` → `project::`. `global` has no prefix to widen to — a wildcard
 * over it would be the whole account, which is what NOT scoping already means.
 */
function ownerPrefixOf(scope: string): string | null {
  const sep = scope.indexOf('::');
  if (sep === -1) return null;
  const prefix = scope.slice(0, sep);
  const rest = scope.slice(sep + 2);
  if (prefix === 'project') return 'project::';
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return `${prefix}::${rest.slice(0, slash + 1)}`;
}

/**
 * The pattern the picker would ADD for what the user typed, or `null`.
 *
 * `scopePatternOptions` above only decides what is OFFERED from the catalog,
 * and the catalog only ever contains scopes that already hold a memory. A key
 * scoped to a scope with no memories in it yet is legitimate and common — the
 * CI token you issue before the first run — so the picker needs a way to accept
 * a value that is not on the list. This is that way; `Combobox`'s `creatable`
 * prop calls it with the search query.
 *
 * Validation is DELEGATED to `ApiKeyScopePatternSchema`, which is the same
 * schema the edge and the `api_tokens_scopes_shape` CHECK are mirrored from —
 * casing, trimming, the 200-character cap, and the rule that a `*` is a
 * wildcard only directly after a `/` or a `::`. A second copy of that grammar
 * here is exactly the third matcher this module's header forbids.
 *
 * `null` for anything the database would reject, so the picker never offers a
 * row that cannot be saved: a mid-token `repo::mthines/lore*`, an uppercase or
 * space-bearing entry that survives normalisation as something else, an empty
 * query.
 */
export function creatableScopePattern(query: string): string | null {
  const parsed = ApiKeyScopePatternSchema.safeParse(query);
  return parsed.success ? parsed.data : null;
}
