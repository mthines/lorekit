'use client';

/**
 * GroomingRuleBuilder — the Settings → Grooming rule builder.
 *
 * A form for an inline (unsaved) retention rule with a LIVE match count
 * (debounced `groom.preview`), a review/auto toggle, and a Run-now control
 * that archives the current matches (`groom.run`) — plus the list of already
 * SAVED policies below it. Every read/write goes through `lib/api/groom.ts`
 * (the `memories` REST function), never a direct supabase-js query.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { GroomRequest, RetentionPolicy } from '@lorekit/schemas/retention';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/providers/ToastProvider';
import {
  useCreatePolicy,
  useDeletePolicy,
  useGroomPreview,
  useGroomRun,
  usePolicies,
  useUpdatePolicy,
} from '@/lib/queries/groom';

const LABEL_CLASS = 'text-xs font-medium text-[var(--color-content-secondary)]';
const INPUT_CLASS =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50';

/** How long to wait after the last keystroke before re-previewing. */
const PREVIEW_DEBOUNCE_MS = 400;

interface Conditions {
  scope: string;
  minAgeDays: string;
  unseenDays: string;
  maxSeenCount: string;
}

const EMPTY_CONDITIONS: Conditions = { scope: '', minAgeDays: '', unseenDays: '', maxSeenCount: '' };

/** Parse a numeric field, or `undefined` when blank — never NaN out to the API. */
function parseIntField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function toGroomRequest(c: Conditions): GroomRequest | null {
  if (!c.scope.trim()) return null;
  const minAgeDays = parseIntField(c.minAgeDays);
  const unseenDays = parseIntField(c.unseenDays);
  const maxSeenCount = parseIntField(c.maxSeenCount);
  return {
    scope: c.scope.trim(),
    ...(minAgeDays !== undefined ? { min_age_days: minAgeDays } : {}),
    ...(unseenDays !== undefined ? { unseen_days: unseenDays } : {}),
    ...(maxSeenCount !== undefined ? { max_seen_count: maxSeenCount } : {}),
  };
}

/** A saved policy's mode/enabled collapsed to one switch: ON = auto + enabled. */
function isAutoEnabled(policy: Pick<RetentionPolicy, 'mode' | 'enabled'>): boolean {
  return policy.mode === 'auto' && policy.enabled;
}

/** The "Auto (nightly)" switch — shared between the inline form and each saved-policy row. */
function AutoToggle({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={[
        'relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 size-5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        ].join(' ')}
        aria-hidden
      />
    </button>
  );
}

export function GroomingRuleBuilder() {
  const { showToast } = useToast();
  const [conditions, setConditions] = useState<Conditions>(EMPTY_CONDITIONS);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [name, setName] = useState('');
  const [lastArchived, setLastArchived] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RetentionPolicy | null>(null);

  const scopeId = useId();
  const nameId = useId();
  const minAgeId = useId();
  const unseenId = useId();
  const maxSeenId = useId();

  const preview = useGroomPreview();
  const run = useGroomRun();
  const createPolicy = useCreatePolicy();
  const updatePolicy = useUpdatePolicy();
  const deletePolicyMutation = useDeletePolicy();
  const { data: policies = [], isLoading: policiesLoading } = usePolicies();

  const request = useMemo(() => toGroomRequest(conditions), [conditions]);
  const autoScopeOnly =
    autoEnabled &&
    conditions.scope.trim() !== '' &&
    conditions.minAgeDays.trim() === '' &&
    conditions.unseenDays.trim() === '' &&
    conditions.maxSeenCount.trim() === '';
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live match count: re-preview PREVIEW_DEBOUNCE_MS after the form settles.
  // `preview.mutate` rather than a `useQuery` — a throwaway preview belongs to
  // the form's own transient state, not a cached, key-addressable read.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!request) return;
    debounceRef.current = setTimeout(() => {
      preview.mutate(request);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // preview is a stable mutate function identity across renders (react-query).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions.scope, conditions.minAgeDays, conditions.unseenDays, conditions.maxSeenCount]);

  async function handleRunNow() {
    if (!request) return;
    try {
      const result = await run.mutateAsync(request);
      setLastArchived(result.archived);
      showToast(`Archived ${result.archived} lesson${result.archived === 1 ? '' : 's'}.`, 'success');
      preview.mutate(request); // refresh the live count now that matches are gone
    } catch {
      showToast('Could not run the sweep. Try again.', 'error');
    }
  }

  async function handleSavePolicy() {
    if (!request || !('scope' in request) || !name.trim()) return;
    try {
      await createPolicy.mutateAsync({
        scope: request.scope,
        name: name.trim(),
        mode: autoEnabled ? 'auto' : 'review',
        enabled: autoEnabled,
        ...('min_age_days' in request ? { min_age_days: request.min_age_days } : {}),
        ...('unseen_days' in request ? { unseen_days: request.unseen_days } : {}),
        ...('max_seen_count' in request ? { max_seen_count: request.max_seen_count } : {}),
      });
      showToast('Policy saved.', 'success');
      setName('');
    } catch {
      showToast('Could not save the policy.', 'error');
    }
  }

  async function handleTogglePolicy(policy: RetentionPolicy) {
    const nextAuto = !isAutoEnabled(policy);
    try {
      await updatePolicy.mutateAsync({
        id: policy.id,
        body: nextAuto ? { mode: 'auto', enabled: true } : { mode: 'review', enabled: false },
      });
    } catch {
      showToast('Could not update the policy.', 'error');
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deletePolicyMutation.mutateAsync(deleteTarget.id);
      showToast('Policy deleted.', 'success');
    } catch {
      showToast('Could not delete the policy.', 'error');
    } finally {
      setDeleteTarget(null);
    }
  }

  const matchCount = preview.data?.count;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-content-secondary)]">
          Build a rule, see how many lessons it would catch, then run it now or save it to run automatically.
          A rule only ever archives — never permanently deletes.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor={scopeId} className={LABEL_CLASS}>Scope</label>
            <input
              id={scopeId}
              className={INPUT_CLASS}
              placeholder="repo::acme/app"
              value={conditions.scope}
              onChange={(e) => setConditions((c) => ({ ...c, scope: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={minAgeId} className={LABEL_CLASS}>Minimum age (days)</label>
            <input
              id={minAgeId}
              type="number"
              min={1}
              className={INPUT_CLASS}
              value={conditions.minAgeDays}
              onChange={(e) => setConditions((c) => ({ ...c, minAgeDays: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={unseenId} className={LABEL_CLASS}>Unseen for (days)</label>
            <input
              id={unseenId}
              type="number"
              min={1}
              className={INPUT_CLASS}
              value={conditions.unseenDays}
              onChange={(e) => setConditions((c) => ({ ...c, unseenDays: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={maxSeenId} className={LABEL_CLASS}>Seen at most (times)</label>
            <input
              id={maxSeenId}
              type="number"
              min={0}
              className={INPUT_CLASS}
              value={conditions.maxSeenCount}
              onChange={(e) => setConditions((c) => ({ ...c, maxSeenCount: e.target.value }))}
            />
          </div>

          <div className="flex items-center gap-2 pt-6">
            <AutoToggle checked={autoEnabled} label="Auto (nightly)" onToggle={() => setAutoEnabled((v) => !v)} />
            <span className="text-sm text-[var(--color-content-primary)]">Auto (nightly)</span>
          </div>

          {autoScopeOnly && (
            <p
              role="alert"
              className="text-xs text-[var(--color-warning)] sm:col-span-2"
            >
              Auto mode with only a scope archives every unprotected lesson in this
              scope every night. Add an age, unseen, or seen-count condition to narrow it.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
          <p className="text-sm text-[var(--color-content-primary)]" aria-live="polite">
            {!request ? (
              'Enter a scope to preview matches.'
            ) : preview.isPending ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--color-content-secondary)]">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking matches…
              </span>
            ) : matchCount !== undefined ? (
              <>
                <AnimatedNumber value={matchCount} className="font-semibold" /> lesson{matchCount === 1 ? '' : 's'} match this rule
              </>
            ) : (
              'Enter a scope to preview matches.'
            )}
          </p>

          {lastArchived !== null && (
            <p className="text-sm text-[var(--color-success)]">
              Archived <AnimatedNumber value={lastArchived} animateOnMount className="font-semibold" /> lesson{lastArchived === 1 ? '' : 's'}.
            </p>
          )}

          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSavePolicy}
              disabled={!request || !name.trim() || createPolicy.isPending}
              className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-sm font-medium text-[var(--color-content-primary)] transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
            >
              Save policy
            </button>
            <button
              type="button"
              onClick={handleRunNow}
              disabled={!request || run.isPending}
              className="h-9 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {run.isPending ? 'Running…' : 'Run now'}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className={LABEL_CLASS}>Policy name (to save this rule)</label>
          <input
            id={nameId}
            className={INPUT_CLASS}
            placeholder="Stale repo lore"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">Saved policies</h3>
        {policiesLoading ? (
          <p className="text-sm text-[var(--color-content-tertiary)]">Loading…</p>
        ) : policies.length === 0 ? (
          <p className="text-sm text-[var(--color-content-tertiary)]">No saved policies yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {policies.map((policy) => (
              <li
                key={policy.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--color-content-primary)]">{policy.name}</p>
                  <p className="truncate text-xs text-[var(--color-content-tertiary)]">{policy.scope}</p>
                </div>
                <AutoToggle
                  checked={isAutoEnabled(policy)}
                  label={`Auto (nightly) for ${policy.name}`}
                  onToggle={() => { void handleTogglePolicy(policy); }}
                />
                <button
                  type="button"
                  aria-label={`Delete ${policy.name}`}
                  onClick={() => setDeleteTarget(policy)}
                  className="flex size-9 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete policy?"
        description={`"${deleteTarget?.name ?? ''}" will be deleted. The lessons it matched are untouched.`}
        confirmLabel="Delete"
        destructive
        pending={deletePolicyMutation.isPending}
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
