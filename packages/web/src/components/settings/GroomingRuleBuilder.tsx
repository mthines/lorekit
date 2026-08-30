'use client';

/**
 * GroomingRuleBuilder — the Settings → Retention Policies surface.
 *
 * "Retention policy" is the one user-facing noun for this feature (the page
 * title, the feature flag `retention-policies`, and every string below use
 * it) — "grooming" stays the internal/technical name for the underlying
 * mechanism (the `groom.*` MCP tools and REST routes, the CLI's `lorekit
 * groom`/`lorekit-groom` skill, this component's own file name, and the
 * `/settings/grooming` route slug). Renaming those is a separate, much larger
 * change (breaking every existing integration, script and bookmark that names
 * them) and out of scope here — this file only makes the copy a USER reads
 * consistent, not every identifier a developer does.
 *
 * LIST-FIRST: the page opens on the saved policies (or an empty state that
 * teaches) plus a single **Add policy** button. The rule form — scope, the
 * three conditions, the Auto (nightly) toggle, the LIVE match count, and the
 * Save / Run-now actions — lives in a dialog (a centred modal at `md`+, a
 * `BottomSheet` on the phone) opened by Add or by editing a row. The scope is a
 * real single-select scope picker over the account's scope catalog, not a
 * free-text field. Every read/write goes through `lib/queries/groom.ts` (the
 * `memories` REST function), never a direct supabase-js query. A rule only ever
 * ARCHIVES — never a hard delete.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Archive, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { GroomRequest, RetentionPolicy } from '@lorekit/schemas/retention';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormDialog } from '@/components/ui/FormDialog';
import { Combobox, type ComboboxItem } from '@/components/ui/Combobox';
import { Switch } from '@/components/ui/Switch';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { scopeIcon } from '@/components/memory/scope-meta';
import { showToast } from '@/lib/toast';
import { isCanonicalScope } from '@/lib/scope';
import { useScopeTree } from '@/lib/queries/lore';
import type { ScopeNode } from '@/components/lore/ScopeTree';
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

/**
 * Above this many matches, "Run now" routes through a confirm that names the
 * count — a small speed bump before archiving a lot of lore at once (it is all
 * recoverable, so the bar is low, not high).
 */
const RUN_CONFIRM_THRESHOLD = 25;

export interface Conditions {
  scope: string;
  minAgeDays: string;
  unseenDays: string;
  maxSeenCount: string;
}

const EMPTY_CONDITIONS: Conditions = { scope: '', minAgeDays: '', unseenDays: '', maxSeenCount: '' };

/**
 * `?prefillScope=` / `?prefillMinAgeDays=` / `?prefillUnseenDays=` /
 * `?prefillMaxSeenCount=` — how the Lore Explorer's "Create retention policy"
 * action hands off its current scope + retention conditions
 * (`lib/retention-filter.ts`) to this page. Read ONCE (see the mount effect in
 * {@link GroomingRuleBuilder}) so a reload of the resulting `/settings/grooming`
 * URL does not keep reopening the dialog; absent entirely means "no prefill".
 */
function conditionsFromPrefillParams(params: URLSearchParams): Conditions | null {
  const scope = params.get('prefillScope');
  if (!scope) return null;
  return {
    scope,
    minAgeDays: params.get('prefillMinAgeDays') ?? '',
    unseenDays: params.get('prefillUnseenDays') ?? '',
    maxSeenCount: params.get('prefillMaxSeenCount') ?? '',
  };
}

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

/** A saved policy's conditions as an inline groom request (for a preview). */
function policyToRequest(p: RetentionPolicy): GroomRequest {
  return {
    scope: p.scope,
    ...(p.min_age_days !== null ? { min_age_days: p.min_age_days } : {}),
    ...(p.unseen_days !== null ? { unseen_days: p.unseen_days } : {}),
    ...(p.max_seen_count !== null ? { max_seen_count: p.max_seen_count } : {}),
  };
}

/** Prefill the form's condition state from a saved policy (edit mode). */
function conditionsFromPolicy(p: RetentionPolicy): Conditions {
  return {
    scope: p.scope,
    minAgeDays: p.min_age_days !== null ? String(p.min_age_days) : '',
    unseenDays: p.unseen_days !== null ? String(p.unseen_days) : '',
    maxSeenCount: p.max_seen_count !== null ? String(p.max_seen_count) : '',
  };
}

/** The rule as a human sentence: "Older than 90d · unseen 90d · seen ≤ 1". */
function ruleSentence(p: RetentionPolicy): string {
  const parts: string[] = [];
  if (p.min_age_days !== null) parts.push(`Older than ${p.min_age_days}d`);
  if (p.unseen_days !== null) parts.push(`unseen ${p.unseen_days}d`);
  if (p.max_seen_count !== null) parts.push(`seen ≤ ${p.max_seen_count}`);
  return parts.length > 0 ? parts.join(' · ') : 'Every unprotected lesson in scope';
}

/** A saved policy's mode/enabled collapsed to one switch: ON = auto + enabled. */
function isAutoEnabled(policy: Pick<RetentionPolicy, 'mode' | 'enabled'>): boolean {
  return policy.mode === 'auto' && policy.enabled;
}

/** Flatten the scope tree into a single selectable list (top-level + branches). */
function flattenScopeNodes(nodes: ScopeNode[]): ScopeNode[] {
  const out: ScopeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) out.push(...flattenScopeNodes(node.children));
  }
  return out;
}

/**
 * The scope field: a single-select searchable `Combobox` over the account's
 * scope catalog, `creatable` so a scope with no memories yet stays selectable,
 * emitting the canonical scope string and echoing the choice as a `ScopeBadge`.
 */
function ScopeField({ value, onChange }: { value: string; onChange: (scope: string) => void }) {
  const labelId = useId();
  const { data: scopeNodes = [] } = useScopeTree();

  const options: ComboboxItem[] = useMemo(
    () =>
      flattenScopeNodes(scopeNodes).map((n) => ({
        value: n.scope,
        label: n.label,
        hint: n.scope,
        icon: scopeIcon(n.type),
      })),
    [scopeNodes],
  );

  // The escape hatch the catalog cannot provide: `useScopeTree` only holds
  // scopes that already have a memory, and grooming a scope before its first
  // write is normal. `isCanonicalScope` validates against the one shared scope
  // grammar, so a value the database would reject is never offered.
  const createOption = useCallback((query: string): ComboboxItem | null => {
    const trimmed = query.trim();
    if (!isCanonicalScope(trimmed)) return null;
    return { value: trimmed, label: trimmed, hint: 'use this scope' };
  }, []);

  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className={LABEL_CLASS}>
        Scope
      </span>
      <Combobox
        options={options}
        value={value || null}
        onChange={onChange}
        label="Scope"
        triggerLabel={value ? (selectedLabel ?? value) : 'Choose a scope'}
        searchable
        searchPlaceholder="Search or type a scope…"
        creatable={createOption}
        className="w-full justify-between"
      />
      {value && (
        <ScopeBadge scope={value} label showPath className="mt-0.5 text-xs" />
      )}
      <p className="text-[10px] text-[var(--color-content-tertiary)]">
        A scope with no memories yet isn&rsquo;t listed — type it and pick the{' '}
        <em>use this scope</em> row.
      </p>
    </div>
  );
}

/**
 * The rule form, rendered inside the dialog. Owns its own transient state
 * (conditions, name, auto), the debounced live preview, and the Run-now flow;
 * on Save it creates (or, with `initialPolicy`, updates) the policy and closes.
 */
function PolicyForm({
  initialPolicy,
  initialConditions,
  onClose,
}: {
  initialPolicy: RetentionPolicy | null;
  /**
   * Seed the NEW-policy form (ignored when editing, which always seeds from
   * `initialPolicy`) — how a scope + conditions handed off from the Lore
   * Explorer's "Create retention policy" action arrive prefilled.
   */
  initialConditions?: Conditions | null;
  onClose: () => void;
}) {
  const [conditions, setConditions] = useState<Conditions>(() =>
    initialPolicy ? conditionsFromPolicy(initialPolicy) : (initialConditions ?? EMPTY_CONDITIONS),
  );
  const [autoEnabled, setAutoEnabled] = useState(() =>
    initialPolicy ? isAutoEnabled(initialPolicy) : false,
  );
  const [name, setName] = useState(() => initialPolicy?.name ?? '');
  const [lastArchived, setLastArchived] = useState<number | null>(null);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);

  const nameId = useId();
  const minAgeId = useId();
  const unseenId = useId();
  const maxSeenId = useId();

  const preview = useGroomPreview();
  const run = useGroomRun();
  const createPolicy = useCreatePolicy();
  const updatePolicy = useUpdatePolicy();

  const request = useMemo(() => toGroomRequest(conditions), [conditions]);
  const autoScopeOnly =
    autoEnabled &&
    conditions.scope.trim() !== '' &&
    conditions.minAgeDays.trim() === '' &&
    conditions.unseenDays.trim() === '' &&
    conditions.maxSeenCount.trim() === '';
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live match count: re-preview PREVIEW_DEBOUNCE_MS after the form settles.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!request) return;
    debounceRef.current = setTimeout(() => {
      preview.mutate(request);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // preview.mutate is a stable identity across renders (react-query).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions.scope, conditions.minAgeDays, conditions.unseenDays, conditions.maxSeenCount]);

  const matchCount = preview.data?.count;

  async function doRun() {
    if (!request) return;
    setRunConfirmOpen(false);
    try {
      const result = await run.mutateAsync(request);
      setLastArchived(result.archived);
      showToast(`Archived ${result.archived} lesson${result.archived === 1 ? '' : 's'}.`, 'success');
      preview.mutate(request); // refresh the live count now that matches are gone
    } catch {
      showToast('Could not run the sweep. Try again.', 'error');
    }
  }

  function requestRun() {
    if (!request) return;
    if ((matchCount ?? 0) > RUN_CONFIRM_THRESHOLD) {
      setRunConfirmOpen(true);
      return;
    }
    void doRun();
  }

  async function handleSave() {
    if (!request || !('scope' in request) || !name.trim()) return;
    try {
      if (initialPolicy) {
        await updatePolicy.mutateAsync({
          id: initialPolicy.id,
          body: {
            name: name.trim(),
            mode: autoEnabled ? 'auto' : 'review',
            enabled: autoEnabled,
            min_age_days: parseIntField(conditions.minAgeDays) ?? null,
            unseen_days: parseIntField(conditions.unseenDays) ?? null,
            max_seen_count: parseIntField(conditions.maxSeenCount) ?? null,
          },
        });
        showToast('Policy updated.', 'success');
      } else {
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
      }
      onClose();
    } catch {
      showToast(initialPolicy ? 'Could not update the policy.' : 'Could not save the policy.', 'error');
    }
  }

  const savePending = createPolicy.isPending || updatePolicy.isPending;

  return (
    <div className="flex flex-col gap-4">
      {initialPolicy ? (
        // Editing: the scope combobox stays interactive-looking but `handleSave`'s
        // update call has no `scope` field (`PolicyUpdateBodySchema` doesn't take one),
        // so letting the user change it here would silently no-op while the toast
        // reports success. Show the fixed scope instead until the API supports moving
        // a saved policy to a different scope.
        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Scope</span>
          <ScopeBadge scope={conditions.scope} label showPath className="text-xs" />
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            A policy&rsquo;s scope can&rsquo;t be changed after it&rsquo;s created — archive this rule and
            create a new one under a different scope.
          </p>
        </div>
      ) : (
        <ScopeField value={conditions.scope} onChange={(scope) => setConditions((c) => ({ ...c, scope }))} />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
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
      </div>

      <div className="flex items-center gap-2">
        <Switch checked={autoEnabled} label="Auto (nightly)" onChange={setAutoEnabled} />
        <span className="text-sm text-[var(--color-content-primary)]">Auto (nightly)</span>
      </div>

      {autoScopeOnly && (
        <p role="alert" className="text-xs text-[var(--color-warning)]">
          Auto mode with only a scope archives every unprotected lesson in this scope every night. Add an
          age, unseen, or seen-count condition to narrow it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
        <p className="text-sm text-[var(--color-content-primary)]" aria-live="polite">
          {!request ? (
            'Choose a scope to preview matches.'
          ) : preview.isPending ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--color-content-secondary)]">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking matches…
            </span>
          ) : matchCount !== undefined ? (
            <>
              <AnimatedNumber value={matchCount} className="font-semibold" /> lesson{matchCount === 1 ? '' : 's'} match this rule
            </>
          ) : (
            'Choose a scope to preview matches.'
          )}
        </p>
        {lastArchived !== null && (
          <p className="text-sm text-[var(--color-success)]">
            Archived <AnimatedNumber value={lastArchived} animateOnMount className="font-semibold" /> lesson{lastArchived === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className={LABEL_CLASS}>Policy name</label>
        <input
          id={nameId}
          className={INPUT_CLASS}
          placeholder="Stale repo lore"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={requestRun}
          disabled={!request || run.isPending}
          className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          {run.isPending ? 'Running…' : 'Run now'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!request || !name.trim() || savePending}
          className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {initialPolicy ? 'Save changes' : 'Save policy'}
        </button>
      </div>

      <ConfirmDialog
        open={runConfirmOpen}
        title="Run this rule now?"
        description={`Archive ${matchCount ?? 0} lesson${matchCount === 1 ? '' : 's'}? They can be restored from Archived at any time.`}
        confirmLabel="Archive them"
        pending={run.isPending}
        onConfirm={() => void doRun()}
        onCancel={() => setRunConfirmOpen(false)}
      />
    </div>
  );
}

/** A saved-policy row: the rule as a sentence, the scope badge, a status pill, a
 *  quiet live "catches ~N now" count, the Auto toggle, an edit and a delete. */
function PolicyRow({
  policy,
  onEdit,
  onToggle,
  onDelete,
}: {
  policy: RetentionPolicy;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const auto = isAutoEnabled(policy);
  const preview = useGroomPreview();

  // A saved policy's conditions are static, so preview ONCE per (id + rule).
  useEffect(() => {
    preview.mutate(policyToRequest(policy));
    // preview.mutate is a stable identity across renders (react-query).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy.id, policy.min_age_days, policy.unseen_days, policy.max_seen_count, policy.scope]);

  const catches = preview.data?.count;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-[var(--color-content-primary)]">{policy.name}</p>
          <span
            className={[
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
              auto
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'bg-[var(--color-bg)] text-[var(--color-content-tertiary)]',
            ].join(' ')}
          >
            {auto ? 'Auto nightly' : 'Review'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScopeBadge scope={policy.scope} label className="text-xs" />
          <span className="truncate text-xs text-[var(--color-content-tertiary)]">{ruleSentence(policy)}</span>
        </div>
      </div>

      {catches !== undefined && (
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-content-tertiary)]">
          catches ~{catches} now
        </span>
      )}

      <Switch
        checked={auto}
        label={`Auto (nightly) for ${policy.name}`}
        onChange={onToggle}
      />
      <button
        type="button"
        aria-label={`Edit ${policy.name}`}
        onClick={onEdit}
        className="flex size-9 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        <Pencil className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Delete ${policy.name}`}
        onClick={onDelete}
        className="flex size-9 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function GroomingRuleBuilder() {
  const reduceMotion = useReducedMotion();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<RetentionPolicy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RetentionPolicy | null>(null);
  const [prefillConditions, setPrefillConditions] = useState<Conditions | null>(null);

  const updatePolicy = useUpdatePolicy();
  const deletePolicyMutation = useDeletePolicy();
  const { data: policies = [], isLoading: policiesLoading } = usePolicies();

  // Consume a one-shot `?prefillScope=…` handoff from the Lore Explorer's
  // "Create retention policy" action (see `LoreExplorer.handleCreatePolicy`):
  // open the New policy dialog pre-filled with the scope + conditions the
  // Explorer had active, then strip the params so reloading this URL does not
  // reopen the dialog every time. Runs once per mount — searchParams is
  // intentionally omitted from the deps so a later, unrelated navigation to
  // this same page (e.g. closing and reopening via "Add policy") never
  // replays a stale prefill.
  useEffect(() => {
    const prefill = conditionsFromPrefillParams(searchParams);
    if (!prefill) return;
    setPrefillConditions(prefill);
    setEditingPolicy(null);
    setDialogOpen(true);
    router.replace('/settings/grooming', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    // Clear any lingering prefill from a previous Explorer handoff — a manual
    // "Add policy" click always starts from a blank form.
    setPrefillConditions(null);
    setEditingPolicy(null);
    setDialogOpen(true);
  }

  function openEdit(policy: RetentionPolicy) {
    setEditingPolicy(policy);
    setDialogOpen(true);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-[var(--color-content-secondary)]">
          Saved rules archive stale lore for you — reviewed by hand or swept nightly. A rule only ever
          archives; it never permanently deletes.
        </p>
        <button
          type="button"
          onClick={openCreate}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          <Plus className="size-4" aria-hidden />
          Add policy
        </button>
      </div>

      {policiesLoading ? (
        <p className="text-sm text-[var(--color-content-tertiary)]">Loading…</p>
      ) : policies.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]">
            <Archive className="size-5" aria-hidden />
          </span>
          <p className="max-w-sm text-sm text-[var(--color-content-secondary)]">
            Retention policies archive stale lore automatically, on your rules. Never a hard delete.
          </p>
          <button
            type="button"
            onClick={openCreate}
            className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          >
            <Plus className="size-4" aria-hidden />
            Add policy
          </button>
        </div>
      ) : (
        <motion.ul layout={!reduceMotion} className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {policies.map((policy) => (
              <motion.li
                key={policy.id}
                layout={!reduceMotion}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <PolicyRow
                  policy={policy}
                  onEdit={() => openEdit(policy)}
                  onToggle={() => { void handleTogglePolicy(policy); }}
                  onDelete={() => setDeleteTarget(policy)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}

      <FormDialog
        open={dialogOpen}
        title={editingPolicy ? 'Edit policy' : 'New retention policy'}
        description="Build a rule, see how many lessons it would catch, then run it now or save it to run automatically. A rule only ever archives — never permanently deletes."
        onClose={() => setDialogOpen(false)}
      >
        {/* Keyed so the form's transient state resets between opens / targets. */}
        <PolicyForm
          key={editingPolicy?.id ?? 'new'}
          initialPolicy={editingPolicy}
          initialConditions={prefillConditions}
          onClose={() => setDialogOpen(false)}
        />
      </FormDialog>

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
