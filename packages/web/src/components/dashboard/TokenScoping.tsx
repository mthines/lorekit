'use client';

/**
 * The two scoping surfaces of the API-keys page: the row badges and the
 * picker.
 *
 * Split out of `TokenManager.tsx` so they can be storied. `TokenManager`
 * itself calls three server actions, which do not resolve in a browser story,
 * so it is not storyable as a whole — these two are pure presentational
 * components over `token-scoping.ts` and render standalone.
 *
 * The wording and validation decisions (what a badge counts, how the sentence
 * reads, which wildcards the picker offers, what may be typed into it) live in
 * `lib/token-scoping.ts` with its own unit tests. What lives here is the
 * rendering and the interaction.
 */

import { useCallback, useState } from 'react';
import { Filter, Building2 } from 'lucide-react';
import {
  ORG_ACCESS_TIERS,
  creatableScopePattern,
  describeScoping,
  isScoped,
  orgBadgeLabel,
  scopeBadgeLabel,
  scopePatternOptions,
  type OrgAccess,
  type TokenScoping,
} from '@/lib/token-scoping';
import { Combobox, type ComboboxItem } from '@/components/ui/Combobox';

/**
 * The scoping badges — rendered only when the key IS scoped.
 *
 * Counts rather than the patterns themselves: a token row is one line, and
 * three repo paths do not fit it. The exact patterns live in the row's `title`,
 * where there is room to be precise, so the badge answers "is this key
 * narrowed, and roughly how much" at a glance and the detail is one hover away.
 */
export function ScopingBadges({ scoping, orgNames }: { scoping: TokenScoping; orgNames: Record<string, string> }) {
  const scopeLabel = scopeBadgeLabel(scoping.scopes);
  const orgLabel = orgBadgeLabel(scoping);
  if (!scopeLabel && !orgLabel) return null;
  const title = describeScoping(scoping, orgNames);
  return (
    <>
      {scopeLabel && (
        <span
          title={title}
          className="inline-flex items-center gap-1 rounded-md bg-[#60a5fa1a] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-scope-repo)]"
        >
          <Filter className="size-2.5" aria-hidden />
          {scopeLabel}
        </span>
      )}
      {orgLabel && (
        <span
          title={title}
          className="inline-flex items-center gap-1 rounded-md bg-[#a78bfa1a] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-scope-global)]"
        >
          <Building2 className="size-2.5" aria-hidden />
          {orgLabel}
        </span>
      )}
    </>
  );
}

/**
 * The scoping half of the create form: which scopes, and which tenancy.
 *
 * Both controls are the shared `Combobox` in `multiple` mode, so they are an
 * anchored popover at `md`+ and a `BottomSheet` on the phone — the repo-wide
 * rule for a transient selection surface, inherited rather than re-implemented.
 *
 * Collapsed behind a disclosure and OFF by default, because unrestricted is the
 * right answer for most keys and a form that asks every question up front makes
 * the common path longer. The summary line states the current answer so the
 * collapsed state is never ambiguous about what it is hiding.
 */
export function ScopingFields({
  scoping,
  onChange,
  scopeCatalog,
  orgs,
  defaultOpen = false,
}: {
  scoping: TokenScoping;
  onChange: (next: TokenScoping) => void;
  scopeCatalog: readonly string[];
  orgs: readonly { id: string; name: string }[];
  /**
   * Start expanded. The create form collapses (unrestricted is the right answer
   * for most keys, so the common path should be short); the row editor does
   * not, because expanding it IS the thing the user just clicked.
   */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // The CURRENT selection is merged into the offered set, not just the catalog.
  // `scopeCatalog` holds scopes that have a memory; a pattern already saved on
  // the key — or one just added through `creatable` — need not be one of them,
  // and an option-less selected value has no row to untick. (`creatable` cannot
  // stand in for that: at an empty query it returns null, so the only way back
  // out would be to retype the pattern exactly.) Selected-but-uncatalogued
  // patterns are appended after the catalog's own, so the offered order the
  // reader learned does not shuffle as they pick.
  const offered = scopePatternOptions(scopeCatalog);
  const scopeOptions: ComboboxItem[] = [
    ...offered,
    ...scoping.scopes.filter((s) => !offered.includes(s)),
  ].map((value) => ({
    value,
    label: value,
    // A wildcard is the option a reader most needs explained — it is the only
    // one whose meaning is not literally its own text.
    ...(value.endsWith('*') ? { hint: 'every scope under this owner' } : {}),
  }));
  // The escape hatch the catalog cannot provide: `scopeCatalog` only holds
  // scopes that already have a memory, and scoping a key to a scope BEFORE its
  // first write is normal. `creatableScopePattern` validates against the one
  // shared schema, so a value the database would reject is never offered.
  const createScopeOption = useCallback((query: string): ComboboxItem | null => {
    const value = creatableScopePattern(query);
    if (value === null) return null;
    return { value, label: value, hint: 'use this scope' };
  }, []);
  const orgOptions: ComboboxItem[] = orgs.map((o) => ({ value: o.id, label: o.name }));
  const orgNames = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-medium text-[var(--color-content-secondary)]">
          Scoping
        </span>
        <span className="truncate text-[10px] text-[var(--color-content-tertiary)]">
          {isScoped(scoping) ? describeScoping(scoping, orgNames) : 'Unrestricted'}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] p-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]">
              Scopes
            </span>
            <Combobox
              multiple
              options={scopeOptions}
              value={scoping.scopes}
              onChange={(scopes) => onChange({ ...scoping, scopes })}
              label="Scopes"
              countNoun="scopes"
              searchable
              searchPlaceholder="Search or type a scope…"
              creatable={createScopeOption}
              triggerLabel={scoping.scopes.length === 0 ? 'Any scope' : undefined}
            />
            <p className="text-[10px] text-[var(--color-content-tertiary)]">
              Leave empty for any scope. A <code>*</code> option covers every scope under that owner,
              including ones created later. A scope with no memories yet is not on the list — type it
              and pick the <em>use this scope</em> row.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]">
              Organisations
            </span>
            <div className="flex flex-wrap gap-2">
              {ORG_ACCESS_TIERS.map(({ value, label, desc }) => (
                <button
                  key={value}
                  type="button"
                  // Choosing a tenancy other than `selected` DROPS any orgs
                  // already picked. The database rejects the pair outright
                  // (`api_tokens_org_ids_match_access`), and carrying a hidden
                  // list that the next save would reject is worse than losing
                  // two clicks.
                  onClick={() =>
                    onChange({
                      ...scoping,
                      org_access: value as OrgAccess,
                      org_ids: value === 'selected' ? scoping.org_ids : [],
                    })
                  }
                  className={[
                    'flex flex-1 items-start rounded-lg border p-2.5 text-left transition-all duration-150',
                    scoping.org_access === value
                      ? 'border-[var(--color-accent)] bg-[var(--color-bg-raised)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-raised)]',
                  ].join(' ')}
                >
                  <span>
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="block text-[10px] text-[var(--color-content-tertiary)]">{desc}</span>
                  </span>
                </button>
              ))}
            </div>

            {scoping.org_access === 'selected' && (
              <Combobox
                multiple
                options={orgOptions}
                value={scoping.org_ids}
                onChange={(org_ids) => onChange({ ...scoping, org_ids })}
                label="Organisations"
                countNoun="orgs"
                searchable
                searchPlaceholder="Search organisations…"
                triggerLabel={scoping.org_ids.length === 0 ? 'Pick at least one' : undefined}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
