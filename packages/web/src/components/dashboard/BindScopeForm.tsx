'use client';

/**
 * BindScopeForm — Settings → Organization → "Bind a scope".
 *
 * A searchable `Combobox` over the account's WHOLE scope catalog, then an
 * explicit Bind. It replaced a free-text input over a row of suggestion chips
 * whose source was a direct `memories` select (`order by scope limit 500`,
 * deduped to 100, 20 rendered): an alphabetical prefix, so on a busy account a
 * scope that sorted late was never loaded and searching for it found nothing.
 *
 * The catalog is the shared scope-tree query (`useScopeTree`, `GET
 * /memories/scopes`), the same read the grooming rule builder's scope picker
 * uses, so visiting the Explorer first means this opens with the list already
 * cached. What is offered — owner wildcards, minus what the org already has —
 * is decided in the pure `lib/scope-binding-options.ts`.
 *
 * Picking a row SELECTS it; Bind commits. The chips bound on click, which is
 * cheap to undo but shares the scope's future writes with every member the
 * moment it lands — one deliberate press is worth asking for.
 *
 * Split out of `OrganizationManager` so it can be storied: the bind itself is a
 * server action, so the parent owns it and passes `onBind`.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { Link } from 'lucide-react';
import { Combobox, type ComboboxItem } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { scopeIcon } from '@/components/memory/scope-meta';
import { useScopeTree } from '@/lib/queries/lore';
import { flattenScopeTree } from '@/lib/scope-tree';
import { bindableScopeOptions, creatableBindingScope, type BindableScopeOption } from '@/lib/scope-binding-options';

export interface BindScopeFormProps {
  orgName: string;
  /** Scopes and wildcards already bound to this org — never offered again. */
  boundScopes: readonly string[];
  /**
   * Bind the scope. Resolves to an error message to show, or `null` once the
   * binding exists — the form then clears for the next one.
   */
  onBind: (scope: string) => Promise<string | null>;
  onCancel?: () => void;
}

function toItem(option: BindableScopeOption): ComboboxItem {
  return { value: option.value, label: option.label, hint: option.hint, icon: scopeIcon(option.type) };
}

export function BindScopeForm({ orgName, boundScopes, onBind, onCancel }: BindScopeFormProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const { data: scopeNodes, isLoading, isError } = useScopeTree();

  const catalogOptions = useMemo(
    () => bindableScopeOptions(flattenScopeTree(scopeNodes ?? []).map((n) => n.scope), boundScopes),
    [scopeNodes, boundScopes],
  );
  // A value picked through `creatable` is not in the catalog, and the trigger
  // has no label to show for an option-less value — so it is kept as a row.
  const options = useMemo(() => {
    const items = catalogOptions.map(toItem);
    if (selected && !items.some((o) => o.value === selected)) {
      const created = creatableBindingScope(selected, boundScopes);
      if (created) items.push(toItem(created));
    }
    return items;
  }, [catalogOptions, selected, boundScopes]);

  const createOption = useCallback(
    (query: string): ComboboxItem | null => {
      const created = creatableBindingScope(query, boundScopes);
      return created ? toItem(created) : null;
    },
    [boundScopes],
  );

  const selectedLabel = options.find((o) => o.value === selected)?.label;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) {
      setError('Choose a scope to bind');
      return;
    }
    const scope = selected;
    setError('');
    startTransition(async () => {
      const failure = await onBind(scope);
      if (failure) {
        setError(failure);
        return;
      }
      setSelected(null);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
    >
      <p className="text-xs font-medium text-[var(--color-content-secondary)]">Bind a scope</p>
      <p className="text-[10px] text-[var(--color-content-tertiary)]">
        Memories written under this scope are automatically shared with {orgName} for write-capable members. Use a
        wildcard (e.g. <code className="font-mono">repo::dash0hq/*</code>) to bind every scope under a prefix at
        once.
      </p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-content-secondary)]">
          Scope
        </span>
        <Combobox
          options={options}
          value={selected}
          onChange={(scope) => {
            setSelected(scope);
            setError('');
          }}
          label="Scope"
          triggerLabel={selected ? (selectedLabel ?? selected) : 'Choose a scope'}
          searchable
          searchPlaceholder="Search or type a scope…"
          creatable={createOption}
          className="w-full justify-between"
        />
        {selected && (
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            Binds <code className="break-all font-mono text-[var(--color-content-secondary)]">{selected}</code>
          </p>
        )}
        <p className="text-[10px] text-[var(--color-content-tertiary)]">
          {isLoading
            ? 'Loading your scopes…'
            : isError
              ? "Couldn't load your scopes — you can still type one."
              : 'Search by owner, repo, or branch.'}{' '}
          A scope with no memories yet isn&rsquo;t listed — type it and pick the <em>use this scope</em> row.
        </p>
      </div>

      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="md"
          isLoading={pending}
          disabled={!selected}
          leftIcon={<Link className="size-4" aria-hidden />}
          analyticsId="org.bind-scope-submit"
        >
          Bind scope
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" size="md" analyticsId="org.bind-scope-cancel" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
