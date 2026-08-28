'use client';

/**
 * The Developer settings page's flag-override control — one row per
 * registered flag, a variant picker, and a per-flag / global reset.
 *
 * Every change goes through a Server Action (`overrides-actions.ts`), which
 * writes the httpOnly override cookie and calls `revalidatePath('/', 'layout')`.
 * That revalidation is what makes an override apply everywhere at once: the
 * dashboard layout re-runs `getAllServerFlags()` on the next render, so both
 * a Server Component reading `getServerFlag` directly AND a Client Component
 * reading `useFeatureFlag` (fed by the same re-rendered `FeatureFlagsProvider`)
 * see the new value — no separate client-side toggle state to keep in sync.
 */
import { useState, useTransition } from 'react';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useToast } from '@/components/providers/ToastProvider';
import {
  clearAllFlagOverridesAction,
  clearFlagOverrideAction,
  setFlagOverrideAction,
} from '@/lib/feature-flags/overrides-actions';

/** The "no override — resolve normally" segment. Never a real variant name (kebab-case flag keys can't collide). */
const AUTO = 'auto' as const;

export interface DeveloperFlagRow {
  key: string;
  description: string;
  owner: string;
  tags: readonly string[];
  variants: readonly string[];
  isExperiment: boolean;
  value: unknown;
  /** The variant currently in effect — an override's variant if one is active, else the resolved one. */
  variant: string;
  /** OpenFeature resolution reason: `STATIC`, `SPLIT`, or `OVERRIDE`. */
  reason: string;
  overrideActive: boolean;
}

export function DeveloperFlagsPanel({ rows }: { rows: readonly DeveloperFlagRow[] }) {
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const anyOverrideActive = rows.some((row) => row.overrideActive);

  function applyOverride(row: DeveloperFlagRow, selected: string) {
    setPendingKey(row.key);
    startTransition(async () => {
      if (selected === AUTO) {
        await clearFlagOverrideAction(row.key);
        showToast(`${row.key}: override cleared`);
      } else {
        await setFlagOverrideAction(row.key, selected);
        showToast(`${row.key}: overridden to "${selected}"`);
      }
      setPendingKey(null);
    });
  }

  function resetAll() {
    startTransition(async () => {
      await clearAllFlagOverridesAction();
      showToast('All flag overrides cleared');
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-content-secondary)]">
          {rows.length} flag{rows.length === 1 ? '' : 's'} registered.
          {anyOverrideActive ? ' Overrides apply only to your own session.' : ' No overrides active.'}
        </p>
        {anyOverrideActive && (
          <button
            type="button"
            onClick={resetAll}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-content-secondary)] transition-colors hover:text-[var(--color-content-primary)] disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset all
          </button>
        )}
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs font-medium text-[var(--color-content-primary)]">{row.key}</code>
              {row.isExperiment && <Badge variant="purple">experiment</Badge>}
              {row.overrideActive && <Badge variant="amber">override active</Badge>}
              <span className="text-[10px] text-[var(--color-content-tertiary)]">{row.owner}</span>
            </div>
            <p className="text-xs text-[var(--color-content-secondary)]">{row.description}</p>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                label={`Override for ${row.key}`}
                items={[
                  { value: AUTO, label: 'Auto' },
                  ...row.variants.map((variant) => ({ value: variant, label: variant })),
                ]}
                value={row.overrideActive ? row.variant : AUTO}
                onChange={(selected) => applyOverride(row, selected)}
              />
              <span className="text-[10px] text-[var(--color-content-tertiary)]">
                Effective: <code>{String(row.value)}</code> ({row.variant} ·{' '}
                {row.reason.toLowerCase()})
                {pendingKey === row.key && isPending ? ' — applying…' : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
