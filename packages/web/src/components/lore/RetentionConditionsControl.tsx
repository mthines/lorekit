'use client';

/**
 * RetentionConditionsControl
 *
 * The Explorer's "Age & activity" filter: the same min-age / unseen / seen-at-
 * most trio a saved retention policy matches on (`lib/retention-filter.ts`),
 * exposed as a filter over the list rather than only as a preview count inside
 * the Settings → Retention Policies dialog. Setting one narrows the list to
 * the lessons a policy with these conditions would catch — verification before
 * a policy is ever saved.
 *
 * Deliberately an INLINE disclosure — a row that appears below the control row,
 * the same slot `FilterPillRow` occupies — rather than a floating popover.
 * `FilterMenu`'s popover/`BottomSheet` split exists because a categorical
 * dimension's value list is unbounded and needs its own scrollable surface;
 * three numeric inputs do not, so the simpler, portal-free disclosure is the
 * right amount of machinery for this control.
 *
 * Rendered only while the `retention-policies` flag is on (`LoreExplorer`
 * gates the trigger and the panel) — its "Create retention policy" hand-off
 * points at `/settings/grooming`, which 404s while the flag is off, so the
 * whole control stays hidden alongside its destination rather than
 * dead-ending.
 */

import { useId } from 'react';
import { Archive, Clock, X } from 'lucide-react';
import {
  hasRetentionConditions,
  parseCondition,
  RETENTION_CONDITION_BOUNDS,
  RETENTION_CONDITION_PLACEHOLDERS,
  retentionConditionsCount,
  retentionConditionsPhrase,
  type RetentionConditions,
} from '@/lib/retention-filter';

const LABEL_CLASS = 'text-[11px] font-medium text-[var(--color-content-secondary)]';
const CAPTION_CLASS = 'text-[10px] text-[var(--color-content-tertiary)]';
const INPUT_CLASS =
  'h-8 w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';

/** The trigger button, rendered inside the control row beside the filter menu. */
export function RetentionConditionsTrigger({
  conditions,
  open,
  onToggle,
}: {
  conditions: RetentionConditions;
  open: boolean;
  onToggle: () => void;
}) {
  const active = hasRetentionConditions(conditions);
  const count = retentionConditionsCount(conditions);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={active ? retentionConditionsPhrase(conditions) : 'Age & activity filter'}
      className={[
        'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150',
        active || open
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      <Clock className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{active ? retentionConditionsPhrase(conditions) : 'Age & activity'}</span>
      {count > 0 && (
        <span className="flex size-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-[9px] font-semibold text-[var(--color-bg)]">
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * The three numeric inputs, rendered in the disclosure row when the trigger is
 * open. Also hosts the "Create retention policy" hand-off — deliberately
 * INSIDE this popover rather than a separate banner above the results: the
 * action only makes sense in the context of the numbers that produced it, and
 * a banner spanning the full list width overstated an action that is really a
 * follow-up to what you just typed here. It sits beside "Done" in the action
 * group, not in a bordered box of its own: the box read as a second panel
 * competing with the inputs, when it is just the row's primary action.
 *
 * Each field is LABELLED WITH THE METADATA ROW IT TESTS — "Created", "Last
 * agent open", "Recurrence" are the same three words the lesson detail sheet
 * shows — so a reader can open any returned lesson and check the claim against
 * identical vocabulary. The older labels ("Minimum age", "Not seen in", "Seen
 * at most") named the CONDITION rather than the DATA, which left no way to
 * tell whether a given lesson genuinely matched.
 */
export function RetentionConditionsPanel({
  conditions,
  onChange,
  onClose,
  onCreatePolicy,
  filterCount = 0,
}: {
  conditions: RetentionConditions;
  onChange: (next: RetentionConditions) => void;
  onClose: () => void;
  /** Hands the current conditions (and the filter bar) off to Settings → Retention Policies. */
  onCreatePolicy: () => void;
  /**
   * How many dimension filters (label/agent/trigger/kind/host/repo/branch/PR)
   * are ALSO active on the Explorer's own filter bar — a policy created from
   * here carries those too (`handleCreatePolicy`'s `prefillFilters`), so the
   * hand-off is offered whenever EITHER carries something, not just the three
   * fields this popover owns.
   */
  filterCount?: number;
}) {
  const minAgeId = useId();
  const unseenId = useId();
  const maxSeenId = useId();

  /** Parse one field's raw input into the condition set — blank clears it. */
  function setField(field: keyof RetentionConditions, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      const rest = { ...conditions };
      delete rest[field];
      onChange(rest);
      return;
    }
    // Same per-field bounds `normalizeRetentionConditions` enforces (min 1 for
    // age/unseen, min 0 for seen-count) — checking only `n >= 0` here let an
    // out-of-range value pass this guard and then silently revert to blank on
    // the next render, since normalization would drop it right back out.
    const n = parseCondition(trimmed, RETENTION_CONDITION_BOUNDS[field]);
    if (n !== undefined) onChange({ ...conditions, [field]: n });
  }

  const conditionsActive = hasRetentionConditions(conditions);
  const active = conditionsActive || filterCount > 0;

  return (
    <div
      role="group"
      aria-label="Age and activity conditions"
      className="flex flex-col gap-2 border-b border-[var(--color-border)] px-3 py-2.5"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={minAgeId} className={LABEL_CLASS}>Created</label>
          <input
            id={minAgeId}
            type="number"
            min={1}
            placeholder={String(RETENTION_CONDITION_PLACEHOLDERS.minAgeDays)}
            className={INPUT_CLASS}
            value={conditions.minAgeDays ?? ''}
            onChange={(e) => setField('minAgeDays', e.target.value)}
          />
          <p className={CAPTION_CLASS}>More than this many days ago</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={unseenId} className={LABEL_CLASS}>Last agent open</label>
          <input
            id={unseenId}
            type="number"
            min={1}
            placeholder={String(RETENTION_CONDITION_PLACEHOLDERS.unseenDays)}
            className={INPUT_CLASS}
            value={conditions.unseenDays ?? ''}
            onChange={(e) => setField('unseenDays', e.target.value)}
          />
          {/* Spelling out the never-opened fallback here is the point: it is
              the one rule a reader cannot infer from a lesson's metadata, and
              getting it wrong is what made a week-old lesson look like it had
              gone unread for 90 days. */}
          <p className={CAPTION_CLASS}>More than this many days ago. Never opened counts from Created.</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={maxSeenId} className={LABEL_CLASS}>Recurrence</label>
          <input
            id={maxSeenId}
            type="number"
            min={0}
            placeholder={String(RETENTION_CONDITION_PLACEHOLDERS.maxSeenCount)}
            className={INPUT_CLASS}
            value={conditions.maxSeenCount ?? ''}
            onChange={(e) => setField('maxSeenCount', e.target.value)}
          />
          <p className={CAPTION_CLASS}>Written this many times or fewer</p>
        </div>

        {/* Actions sit together at the trailing edge, with Done rightmost so
            it never shifts as the hand-off appears and disappears. */}
        <div className="ml-auto flex items-center gap-1">
          {active && (
            <button
              type="button"
              onClick={onCreatePolicy}
              className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-2.5 text-[11px] font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90"
            >
              <Archive className="size-3.5" aria-hidden />
              Create retention policy
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
          >
            <X className="size-3.5" aria-hidden />
            Done
          </button>
        </div>
      </div>

      {active && (
        <p className={CAPTION_CLASS}>
          {conditionsActive && filterCount > 0
            ? `Showing lessons these conditions and ${filterCount} filter${filterCount === 1 ? '' : 's'} would catch.`
            : filterCount > 0
              ? `A policy created here also carries your ${filterCount} active filter${filterCount === 1 ? '' : 's'}.`
              : 'Showing lessons a retention policy with these conditions would catch.'}
        </p>
      )}
    </div>
  );
}
