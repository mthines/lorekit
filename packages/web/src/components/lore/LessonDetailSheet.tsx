'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { X, Bot, Zap, Clock, CalendarClock, Archive, RotateCcw, Github, Users, UserCircle, Timer, Layers, Cpu, Repeat, BookOpenCheck } from 'lucide-react';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { MemoryOrigin } from '@/components/memory/MemoryOrigin';
import { OwnershipBadge } from '@/components/memory/OwnershipBadge';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { EditableField } from '@/components/ui/EditableField';
import { MarkdownPreview } from '@/components/ui/MarkdownPreview';
import { TagsField } from '@/components/ui/TagsField';
import { FormActionBar } from '@/components/ui/FormActionBar';
import { CONTENT_TABS, CONTENT_TAB_SHORTCUT_KEYS, DEFAULT_CONTENT_TAB, nextTabForKey, shortcutTabForKey, tabAfterSave, type ContentTab } from './content-tabs';
import { useEditableForm } from '@/lib/hooks/useEditableForm';
import { useArchiveLesson, useRestoreLesson } from '@/lib/queries/lore';
import type { LessonEntry } from './LessonCard';
import { updateLesson } from '@/lib/lore';
import { listMemberIdentities } from '@/lib/org-members';
import { scopeRepoUrl } from '@/lib/scope';
import { originLinks } from '@/lib/origin';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { shouldDismissSheet } from '@/components/ui/bottom-sheet';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LessonDetailSheetProps {
  lesson: LessonEntry | null;
  onClose: () => void;
  /** Called after a successful archive, restore, or save so the parent can refresh its list. */
  onMutated?: () => void;
  /**
   * Presentation: a right-side drawer (`drawer`) or a bottom sheet (`sheet`).
   * `auto` (default) picks the sheet below the `md` breakpoint and the drawer
   * above it. An explicit value overrides the breakpoint — used by Storybook to
   * snapshot each presentation deterministically.
   */
  layout?: 'auto' | 'drawer' | 'sheet';
  /**
   * Which Content tab is active on first render. Defaults to `preview`. An
   * explicit value is used by Storybook/tests to pin either tab deterministically
   * (the same rationale as `layout`); the product never sets it.
   */
  initialContentTab?: ContentTab;
}

interface LessonFormValues {
  value: string;
  tags: string[];
  /**
   * Free-text expiry duration typed by the user.
   * Supports: bare number (days), Nd, Nh, Nm, Nw — e.g. "7", "7d", "2w", "12h", "60m".
   * Empty string means "never expires" / clear any existing TTL.
   * Defaults to the remaining days of the current TTL on load (e.g. "30d"), or ""
   * when there is no TTL.  Only submitted when it differs from that initial value.
   */
  ttlInput: string;
}

// ── Promotion threshold ──────────────────────────────────────────────────────
// LoreKit's own documented promotion gate (packages/cli/skill/lorekit-setup/
// rules/self-improvement-loops.md → "Promotion (fast → slow)"): a lesson that
// has recurred at least this many times across runs is promotion-eligible —
// worth hardening into a permanent host rule rather than staying episodic.
// Kept as a named constant here (not re-derived) because the rules doc is the
// authority; this only needs to match its number for the affordance to be honest.
const PROMOTION_SEEN_COUNT_THRESHOLD = 3;

// ── TTL helpers ───────────────────────────────────────────────────────────────

/** Parse a human-readable duration string into API-ready TTL parameters. */
function parseTtlInput(raw: string): { ttlDays: number | null; clearTtl: boolean; error: string | null } {
  const s = raw.trim();
  if (!s) return { ttlDays: null, clearTtl: true, error: null };

  const m = /^(\d+(?:\.\d+)?)\s*(m(?:in)?|h(?:r|ours?)?|d(?:ays?)?|w(?:eeks?)?)?$/i.exec(s);
  if (!m) return { ttlDays: null, clearTtl: false, error: 'e.g. 7, 7d, 2w, 12h, 60m' };

  const n = parseFloat(m[1]);
  const unit = (m[2] ?? 'd')[0].toLowerCase();
  const days =
    unit === 'm' ? n / 1440 :
    unit === 'h' ? n / 24 :
    unit === 'w' ? n * 7 :
    n;

  const rounded = Math.ceil(days);
  if (rounded < 1)   return { ttlDays: null, clearTtl: false, error: 'Minimum is 1 day' };
  if (rounded > 365) return { ttlDays: null, clearTtl: false, error: 'Maximum is 365 days' };
  return { ttlDays: rounded, clearTtl: false, error: null };
}

/**
 * Format remaining TTL as a short string for the expiry input (e.g. "30d").
 * Returns "" when expired so the field starts empty and the user sets a fresh value.
 */
function formatRemainingTtl(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return '';
  return `${Math.ceil(remaining / 86_400_000)}d`;
}

// ── Component ─────────────────────────────────────────────────────────────────


// ── ExpiryControl ────────────────────────────────────────────────────────────
// Free-text TTL input. Accepts human-readable durations (7, 7d, 2w, 12h, 60m).
// Empty = never expires. Validates inline; conversion hints shown for non-day units.

interface ExpiryControlProps {
  currentExpiresAt?: string | null;
  form: UseFormReturn<LessonFormValues>;
  disabled?: boolean;
}

function ExpiryControl({ currentExpiresAt, form, disabled }: ExpiryControlProps) {
  const ttlInput = useWatch({ control: form.control, name: 'ttlInput' });

  const isExpired = currentExpiresAt != null && new Date(currentExpiresAt) < new Date();
  const inputTrimmed = ttlInput.trim();

  // Derive validation / conversion feedback from the current value on every render
  // — no local state needed since the input is controlled via useWatch.
  const parsed = inputTrimmed ? parseTtlInput(inputTrimmed) : null;
  // Show "→ Nd" when the entered unit converts to days (e.g. "2w" → "14d", "12h" → "1d").
  const showConversion =
    parsed != null && parsed.error === null && parsed.ttlDays != null &&
    /[mhw]/i.test(inputTrimmed);

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        type="text"
        placeholder="Never"
        value={ttlInput}
        onChange={(e) => form.setValue('ttlInput', e.target.value, { shouldDirty: true })}
        disabled={disabled}
        aria-label="Expiry"
        className="w-20 bg-transparent text-right text-xs text-[var(--color-content-secondary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] rounded-sm disabled:cursor-default disabled:opacity-50"
      />
      {parsed?.error && (
        <span className="text-xs text-red-400" role="alert">{parsed.error}</span>
      )}
      {showConversion && parsed?.ttlDays != null && (
        <span className="text-xs text-[var(--color-content-tertiary)]">→ {parsed.ttlDays}d</span>
      )}
      {!inputTrimmed && isExpired && (
        <span className="text-xs text-amber-400">Expired</span>
      )}
    </div>
  );
}

// ── ContentSection ─────────────────────────────────────────────────────────
// The memory value with a Preview / Edit tab switch. Preview renders the value
// as safe GitHub-flavored markdown (`MarkdownPreview`); Edit is the raw textarea
// (`EditableField`). Matches the house tab a11y pattern (`ClientConfigTabs`):
// role tablist/tab/tabpanel, aria-selected/-controls, roving tabindex + arrow
// keys, and ≥44px (`min-h-11`) targets. Identical in the drawer and bottom sheet.
//
// The single `Controller` above stays mounted across a tab switch, so the form
// value/dirty state survives; only the rendered panel swaps. Editing dirties the
// form and the pinned Discard/Save bar appears regardless of which tab is shown.

const CONTENT_TAB_LABELS: Record<ContentTab, string> = { preview: 'Preview', edit: 'Edit' };

interface ContentSectionProps {
  tab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  /** False for archived lessons — the Edit tab is disabled and Preview is forced. */
  canEdit: boolean;
  value: string;
  onChange: (value: string) => void;
  onEditEnd: () => void;
  error?: string;
}

function ContentSection({ tab, onTabChange, canEdit, value, onChange, onEditEnd, error }: ContentSectionProps) {
  const tabRefs = useRef<Record<ContentTab, HTMLButtonElement | null>>({ preview: null, edit: null });
  const effectiveTab: ContentTab = canEdit ? tab : 'preview';

  function selectTab(next: ContentTab) {
    if (next === 'edit' && !canEdit) return;
    onTabChange(next);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const next = nextTabForKey(effectiveTab, e.key);
    if (!next) return;
    e.preventDefault();
    if (next === 'edit' && !canEdit) return;
    onTabChange(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section aria-label="Content" className="flex flex-col gap-2">
      {/* Compact segmented control, left-aligned. The heading is dropped — the
          tabs are self-explanatory — but `aria-label="Content"` keeps the
          region named for assistive tech. `w-fit` hugs the two tabs rather than
          stretching into a full-width bar. */}
      <div
        role="tablist"
        aria-label="Content view"
        aria-orientation="horizontal"
        className="flex w-fit gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5"
      >
        {CONTENT_TABS.map((id) => {
          const selected = effectiveTab === id;
          const disabled = id === 'edit' && !canEdit;
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`content-tab-${id}`}
              aria-selected={selected}
              aria-controls={`content-panel-${id}`}
              // Announce the global single-letter shortcut so it is
              // discoverable to assistive tech — but only while the tab can
              // actually be activated, matching `shortcutTabForKey`, which
              // returns null for Edit on an archived memory.
              aria-keyshortcuts={disabled ? undefined : CONTENT_TAB_SHORTCUT_KEYS[id]}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => selectTab(id)}
              onKeyDown={handleKeyDown}
              // Compact on desktop (≈28px) but a ≥44px tap target on mobile.
              className={[
                'flex min-h-11 items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150 md:min-h-7',
                selected
                  ? 'bg-[var(--color-bg-raised)] text-[var(--color-content-primary)] shadow-sm'
                  : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
                disabled ? 'cursor-not-allowed opacity-40' : '',
              ].join(' ')}
            >
              {CONTENT_TAB_LABELS[id]}
            </button>
          );
        })}
      </div>

      {effectiveTab === 'preview' ? (
        // Preview renders directly on the panel background — no card/border/inset.
        <div
          role="tabpanel"
          id="content-panel-preview"
          aria-labelledby="content-tab-preview"
          tabIndex={0}
          // The panel is focusable (it is the tablist's target), so it needs a
          // visible ring — `outline-none` alone would land a keyboard user here
          // invisibly, against packages/web/CLAUDE.md's visible-focus floor.
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <MarkdownPreview value={value} />
        </div>
      ) : (
        <div role="tabpanel" id="content-panel-edit" aria-labelledby="content-tab-edit">
          <EditableField
            label="Content"
            hideLabel
            value={value}
            onChange={onChange}
            onEditEnd={onEditEnd}
            isEditing
            placeholder="Enter memory content…"
            minRows={6}
            error={error}
          />
        </div>
      )}
    </section>
  );
}

export function LessonDetailSheet({ lesson, onClose, onMutated, layout = 'auto', initialContentTab = DEFAULT_CONTENT_TAB }: LessonDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Content view: Preview (rendered markdown, default) vs Edit (raw textarea).
  const [contentTab, setContentTab] = useState<ContentTab>(initialContentTab);
  const queryClient = useQueryClient();
  // Below `md` the panel is a bottom sheet; at/above it a right-side drawer.
  // `useIsMobile` shares one matchMedia listener across all consumers. An
  // explicit `layout` overrides the breakpoint (Storybook).
  const belowMd = useIsMobile();
  const isSheet = layout === 'sheet' || (layout === 'auto' && belowMd);
  const dragControls = useDragControls();
  const archiveMutation = useArchiveLesson();
  const restoreMutation = useRestoreLesson();
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  const isArchived = Boolean(lesson?.archived_at);

  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [updatedByHandle, setUpdatedByHandle] = useState<string | null>(null);

  // Org-owned lore: resolve "Visible to N members" and, where resolvable, the
  // last-updated-by author's real GitHub handle from the single Phase 4
  // identity RPC (`lorekit_org_members_list`, via `listMemberIdentities`). The
  // member count is just that list's length — no separate `listMembers`
  // round-trip. Falls back to a generic "a team member" when the author can't
  // be resolved (e.g. they've since left the org) — never fabricates a handle.
  useEffect(() => {
    const org = lesson?.org;
    if (!org) {
      setMemberCount(null);
      setUpdatedByHandle(null);
      return undefined;
    }
    let cancelled = false;
    const updatedBy = lesson?.updated_by ?? null;
    (async () => {
      const identities = await listMemberIdentities(org.id);
      if (cancelled) return;
      setMemberCount(identities.length);
      const author = updatedBy ? identities.find((i) => i.user_id === updatedBy) : undefined;
      setUpdatedByHandle(author?.handle ?? null);
    })();
    return () => {
      cancelled = true;
    };
    // Depend on the stable identifying fields (org id, updated_by), not the
    // whole `lesson` object, so this doesn't re-fetch on every unrelated
    // field change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.org?.id, lesson?.updated_by]);

  // Derive default form values from the current lesson. Changing lesson (user
  // opens a different entry) resets the form automatically inside useEditableForm.
  const defaultValues = useMemo<LessonFormValues>(
    () => ({
      value: lesson?.value ?? '',
      tags: lesson?.tags ?? [],
      // Show remaining days on load (e.g. "30d"), or "" when there is no TTL.
      ttlInput: lesson?.expires_at ? formatRemainingTtl(lesson.expires_at) : '',
    }),
    // Deliberately key on lesson identity (scope + key) so that opening the same
    // lesson again after a save does not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lesson?.scope, lesson?.key, lesson?.value, lesson?.tags, lesson?.expires_at],
  );

  const editForm = useEditableForm<LessonFormValues>({
    defaultValues,
    onSave: async (data) => {
      if (!lesson) return 'No memory selected';
      // Only update the TTL when the user actually changed the input from its
      // initial value — avoids nudging the expiry timestamp on every save.
      const initialTtlInput = lesson.expires_at ? formatRemainingTtl(lesson.expires_at) : '';
      let ttlDays: number | null = null;
      let clearTtl = false;
      if (data.ttlInput !== initialTtlInput) {
        const parsed = parseTtlInput(data.ttlInput);
        if (parsed.error) return parsed.error;
        ttlDays = parsed.ttlDays;
        clearTtl = parsed.clearTtl;
      }
      const result = await updateLesson(lesson.scope, lesson.key, {
        value: data.value,
        tags: data.tags,
        ttl_days: ttlDays,
        clear_ttl: clearTtl,
      });
      if (result.error) return result.error;
      // Keep the sidebar open — the user may want to keep reading or editing.
      // Invalidate the list caches so the updated value/tags appear behind the
      // panel without requiring a page refresh. `lore-facets` is included
      // because an edit can add or remove a label, which changes the filter
      // menu's catalog and its per-value counts; without this they stay stale
      // for the 90s staleTime.
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      void queryClient.invalidateQueries({ queryKey: ['lore-facets'] });
      toast.success('Memory saved', { description: lesson.key });
    },
    // After a successful save, return to the Preview tab so the user sees the
    // freshly-rendered saved markdown.
    onSaveSuccess: () => setContentTab(tabAfterSave()),
  });

  const { form, isSaving, saveError, isDirty, handleSubmit, discard } = editForm;

  // Identity of the open lesson (null while the panel is closed).
  const lessonId = lesson ? `${lesson.scope}\u0000${lesson.key}` : null;
  // Reset to Preview whenever a *different* lesson opens. The ref is seeded
  // with the mount-time identity so the first run is a no-op — otherwise this
  // effect would overwrite `initialContentTab` before paint.
  const shownLessonIdRef = useRef(lessonId);
  useEffect(() => {
    if (shownLessonIdRef.current === lessonId) return;
    shownLessonIdRef.current = lessonId;
    setContentTab(DEFAULT_CONTENT_TAB);
  }, [lessonId]);

  // Focus close button on open; restore on close. The delay lets the open
  // animation start first, which means focus can already be somewhere inside
  // the panel by the time it fires (a fast click straight into the Content
  // textarea) — pulling it back to the close button would swallow the keystrokes
  // that follow. So this only ever moves focus INTO the panel, never within it.
  useEffect(() => {
    if (lesson) {
      const timer = setTimeout(() => {
        const close = closeRef.current;
        if (!close) return;
        const panel = close.closest('[role="dialog"]');
        if (panel?.contains(document.activeElement)) return;
        close.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [lesson]);

  // Close on Escape — but only when the form is clean (the useEditableForm hook
  // captures Escape first when the form is dirty to trigger a discard).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && lesson && !isDirty) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lesson, onClose, isDirty]);

  // Global P / E shortcuts switch the Content tab — but never while focus is in
  // a form field (so typing "p"/"e" into the textarea, tags or expiry input is
  // untouched) and never with a command modifier held (`shortcutTabForKey`).
  useEffect(() => {
    if (!lesson) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const inFormField =
        el != null &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
      const next = shortcutTabForKey(e.key, { hasModifier, inFormField, canEdit: !isArchived });
      if (!next) return;
      e.preventDefault();
      setContentTab(next);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lesson, isArchived]);

  function handleArchive() {
    if (!lesson) return;
    const { scope, key } = lesson;
    if (isArchived) {
      restoreMutation.mutate({ scope, key }, {
        onSuccess: (result) => {
          if (result.error) {
            toast.error('Failed to restore', { description: result.error });
            return;
          }
          toast.success('Memory restored', { description: key });
          onMutated?.();
          onClose();
        },
      });
    } else {
      archiveMutation.mutate({ scope, key }, {
        onSuccess: (result) => {
          if (result.error) {
            toast.error('Failed to archive', { description: result.error });
            return;
          }
          toast.success('Memory archived', { description: key });
          onMutated?.();
          onClose();
        },
      });
    }
  }

  return (
    <AnimatePresence>
      {lesson && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            data-testid="lesson-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Panel — a right-side drawer on desktop, a native-style bottom sheet
              on mobile (same convention as the Explorer's filters; the sheet
              geometry + drag-to-close reuse `shouldDismissSheet`, but the panel
              hosts a pinned footer, which the single-scroll `BottomSheet` body
              can't, so it adopts the geometry directly rather than nesting). */}
          <motion.aside
            key="panel"
            drag={isSheet ? 'y' : false}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={
              isSheet
                ? (_e, info) => {
                    if (shouldDismissSheet({ offsetY: info.offset.y, velocityY: info.velocity.y })) {
                      onClose();
                    }
                  }
                : undefined
            }
            initial={isSheet ? { y: '100%' } : { x: '100%', opacity: 0 }}
            animate={isSheet ? { y: 0 } : { x: 0, opacity: 1 }}
            exit={isSheet ? { y: '100%' } : { x: '100%', opacity: 0 }}
            transition={
              isSheet
                ? { type: 'spring', damping: 34, stiffness: 340 }
                : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }
            }
            className={[
              'fixed z-50 flex flex-col bg-[var(--color-bg-raised)] shadow-2xl',
              isSheet
                ? 'inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl border-t border-[var(--color-border)] pb-[env(safe-area-inset-bottom)]'
                : 'inset-y-0 right-0 w-full max-w-lg border-l border-[var(--color-border)]',
            ].join(' ')}
            role="dialog"
            aria-modal="true"
            aria-label="Memory detail"
          >
            {/* Drag handle — bottom sheet only. Grabbing it starts the drag; the
                body scrolls independently (dragListener is off). */}
            {isSheet && (
              <div
                data-testid="lesson-sheet-drag-handle"
                onPointerDown={(e) => dragControls.start(e)}
                className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
              >
                <span aria-hidden className="h-1 w-9 rounded-full bg-[var(--color-border)]" />
              </div>
            )}

            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] p-5">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <ScopeBadge scope={lesson.scope} type={lesson.scope_type} showPath linkRepo />
                  <OwnershipBadge org={lesson.org} />
                  {isArchived && (
                    <span className="rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)]">
                      archived
                    </span>
                  )}
                  {isDirty && (
                    <motion.span
                      key="unsaved-badge"
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85 }}
                      transition={{ duration: 0.15 }}
                      className="rounded-full bg-[var(--color-accent-subtle)] border border-[var(--color-accent-glow)] px-2 py-0.5 text-xs text-[var(--color-accent)]"
                      aria-live="polite"
                    >
                      unsaved
                    </motion.span>
                  )}
                </div>
                <code className="font-mono text-sm font-medium text-[var(--color-content-primary)]">
                  {lesson.key}
                </code>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close detail panel"
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            {/* Body — scrollable */}
            <form
              onSubmit={handleSubmit}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              aria-label="Edit memory"
            >
              {/* `min-h-0` is load-bearing: without it a flex child's default
                  `min-height:auto` refuses to shrink below its content, so
                  `overflow-y-auto` never engages and a tall memory overflows the
                  sheet's `max-h-[90vh]` (clipping the content and pushing the
                  pinned footer off-screen) instead of scrolling inside it. */}
              <div className="group flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
                {/* Content — Preview (rendered markdown) / Edit (raw textarea) */}
                <Controller
                  name="value"
                  control={form.control}
                  rules={{ required: 'Content is required', minLength: { value: 1, message: 'Content cannot be empty' } }}
                  render={({ field, fieldState }) => (
                    <ContentSection
                      tab={contentTab}
                      onTabChange={setContentTab}
                      canEdit={!isArchived}
                      value={field.value}
                      onChange={field.onChange}
                      onEditEnd={field.onBlur}
                      error={fieldState.error?.message}
                    />
                  )}
                />

                {/* Tags — editable */}
                <Controller
                  name="tags"
                  control={form.control}
                  render={({ field }) => (
                    <TagsField
                      label="Tags"
                      tags={field.value}
                      onChange={field.onChange}
                      editable={!isArchived}
                    />
                  )}
                />

                {/* Metadata — read-only */}
                <section aria-label="Metadata">
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                    Metadata
                  </h2>
                  {(() => {
                    const repoUrl = scopeRepoUrl(lesson.scope);
                    const repoDisplay = lesson.scope.replace(/^(repo|branch)::/, '');
                    const hasOrigin = originLinks(lesson, lesson.scope).length > 0;
                    // Grouped into related clusters (ownership · source ·
                    // timeline · location & provenance) separated by a larger
                    // gap so the list is scannable. Each group renders only
                    // when it has at least one row, so an empty group never
                    // leaves a stray gap.
                    // The `<dl>` gap gives the intra-cluster rhythm; the first
                    // row of every cluster after the first adds a top margin
                    // (`mt-2`) so clusters read as grouped WITHOUT a second
                    // `<div>` nesting layer — every `<dt>`/`<dd>` pair stays a
                    // direct `dl > div` child, which the HTML `dl` content model
                    // requires (a `<div>` that wraps more `<div>`s drops the
                    // term/definition semantics for assistive tech).
                    const clusterStart = 'mt-2';
                    return (
                      <dl className="flex flex-col gap-2">
                        {/* Ownership (org-owned lore only) — Owner,
                            last-updated-by author, and "Visible to N members",
                            resolved from the Phase 4 identity RPC above.
                            First cluster: no top margin. */}
                        {lesson.org && (
                          <>
                            <div className="flex items-center gap-2 text-xs">
                              <Users className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                              <dt className="text-[var(--color-content-tertiary)]">Owner</dt>
                              <dd className="ml-auto font-medium text-[var(--color-content-secondary)]">
                                {lesson.org.name}
                              </dd>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <UserCircle className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                              <dt className="text-[var(--color-content-tertiary)]">Last updated by</dt>
                              <dd className="ml-auto text-[var(--color-content-secondary)]">
                                {updatedByHandle ? `@${updatedByHandle}` : 'a team member'}
                              </dd>
                            </div>
                            {memberCount !== null && (
                              <div className="flex items-center gap-2 text-xs">
                                <Users className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Visible to</dt>
                                <dd className="ml-auto text-[var(--color-content-secondary)]">
                                  {memberCount} {memberCount === 1 ? 'member' : 'members'}
                                </dd>
                              </div>
                            )}
                          </>
                        )}

                        {/* Source — the memory's taxonomy (kind/host), which
                            agent recorded it, what triggered it, and how many
                            times it has recurred. Every field is nullable: a
                            row written before migration 00048/00056 (or
                            00059 for recurrence) carries fewer of them, and
                            `lessonFromMemoryEntry` has already reused the
                            shared `inferKindHost` to backfill kind/host from
                            the legacy `loop::<host>-lessons` tag where
                            possible, so this section never re-parses tags
                            itself. First row present starts a new cluster
                            only when Ownership rendered above it. */}
                        {(lesson.kind || lesson.host || lesson.source_agent || lesson.trigger || lesson.seen_count != null || lesson.read_count != null) && (
                          <>
                            {lesson.kind && (
                              <div className={`flex items-center gap-2 text-xs ${lesson.org ? clusterStart : ''}`}>
                                <Layers className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Kind</dt>
                                <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                                  {lesson.kind}
                                </dd>
                              </div>
                            )}
                            {lesson.host && (
                              <div className={`flex items-center gap-2 text-xs ${lesson.org && !lesson.kind ? clusterStart : ''}`}>
                                <Cpu className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Host</dt>
                                <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                                  {lesson.host}
                                </dd>
                              </div>
                            )}
                            {lesson.source_agent && (
                              <div className={`flex items-center gap-2 text-xs ${lesson.org && !lesson.kind && !lesson.host ? clusterStart : ''}`}>
                                <Bot className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Source agent</dt>
                                <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                                  {lesson.source_agent}
                                </dd>
                              </div>
                            )}
                            {lesson.trigger && (
                              <div className={`flex items-center gap-2 text-xs ${lesson.org && !lesson.kind && !lesson.host && !lesson.source_agent ? clusterStart : ''}`}>
                                <Zap className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Trigger</dt>
                                <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                                  {lesson.trigger}
                                </dd>
                              </div>
                            )}
                            {(() => {
                              const seenCount = lesson.seen_count;
                              if (seenCount == null) return null;
                              const eligibleForPromotion = seenCount >= PROMOTION_SEEN_COUNT_THRESHOLD;
                              return (
                                <div
                                  className={`flex items-center gap-2 text-xs ${
                                    lesson.org && !lesson.kind && !lesson.host && !lesson.source_agent && !lesson.trigger
                                      ? clusterStart
                                      : ''
                                  }`}
                                >
                                  <Repeat className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                  <dt className="text-[var(--color-content-tertiary)]">Recurrence</dt>
                                  <dd className="ml-auto flex items-center gap-1.5">
                                    <span className="text-[var(--color-content-secondary)]">seen {seenCount}×</span>
                                    {eligibleForPromotion && (
                                      <Badge
                                        variant="amber"
                                        className="normal-case"
                                        title={`Recurred ${seenCount} times \u2014 LoreKit's own promotion gate (seen_count >= ${PROMOTION_SEEN_COUNT_THRESHOLD}) suggests hardening this into a permanent rule.`}
                                      >
                                        promote?
                                      </Badge>
                                    )}
                                  </dd>
                                </div>
                              );
                            })()}
                            {(() => {
                              const readCount = lesson.read_count;
                              if (readCount == null) return null;
                              return (
                                <div
                                  className={`flex items-center gap-2 text-xs ${
                                    lesson.org && !lesson.kind && !lesson.host && !lesson.source_agent && !lesson.trigger && lesson.seen_count == null
                                      ? clusterStart
                                      : ''
                                  }`}
                                >
                                  <BookOpenCheck className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                  <dt className="text-[var(--color-content-tertiary)]">Consumption</dt>
                                  <dd className="ml-auto">
                                    <Tooltip
                                      content="How many times this memory has actually been READ back by a memory.read/list/search/list_archived call, not just written. Counts only SINCE per-memory tracking began — a 0 here means not read since then, not necessarily never."
                                      side="top"
                                      align="right"
                                    >
                                      <span className="text-[var(--color-content-secondary)]">
                                        {readCount === 0
                                          ? 'no reads recorded'
                                          : `read ${readCount}×${lesson.last_read_at ? ` · last ${new Date(lesson.last_read_at).toLocaleDateString()}` : ''}`}
                                      </span>
                                    </Tooltip>
                                  </dd>
                                </div>
                              );
                            })()}
                          </>
                        )}

                         {/* Timeline — created / updated / expiry / archived.
                            Preceded by ownership and/or source, so the first row
                            always starts a new cluster. */}
                        <div
                          className={`flex items-center gap-2 text-xs ${
                            lesson.org || lesson.kind || lesson.host || lesson.source_agent || lesson.trigger || lesson.seen_count != null || lesson.read_count != null
                              ? clusterStart
                              : ''
                          }`}
                        >
                          <CalendarClock className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                          <dt className="text-[var(--color-content-tertiary)]">Created</dt>
                          <dd className="ml-auto text-[var(--color-content-secondary)]">
                            {new Date(lesson.created_at).toLocaleString()}
                          </dd>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <Clock className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                          <dt className="text-[var(--color-content-tertiary)]">Last updated</dt>
                          <dd className="ml-auto text-[var(--color-content-secondary)]">
                            {new Date(lesson.updated_at).toLocaleString()}
                          </dd>
                        </div>
                        {/* Expiry — editable TTL control */}
                        {!isArchived && (
                          <div className="flex items-start gap-2 text-xs">
                            <Timer className="size-3.5 shrink-0 mt-0.5 text-[var(--color-content-tertiary)]" aria-hidden />
                            <dt className="text-[var(--color-content-tertiary)] pt-0.5">Expires</dt>
                            <dd className="ml-auto">
                              <ExpiryControl
                                currentExpiresAt={lesson.expires_at}
                                form={form}
                                disabled={isSaving}
                              />
                            </dd>
                          </div>
                        )}
                        {isArchived && lesson.expires_at && (
                          <div className="flex items-center gap-2 text-xs">
                            <Timer className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                            <dt className="text-[var(--color-content-tertiary)]">Expires</dt>
                            <dd className="ml-auto text-[var(--color-content-secondary)]">
                              {new Date(lesson.expires_at) < new Date()
                                ? <span className="text-amber-400">Expired</span>
                                : new Date(lesson.expires_at).toLocaleString()}
                            </dd>
                          </div>
                        )}
                        {lesson.archived_at && (
                          <div className="flex items-center gap-2 text-xs">
                            <Archive className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                            <dt className="text-[var(--color-content-tertiary)]">Archived</dt>
                            <dd className="ml-auto text-[var(--color-content-secondary)]">
                              {new Date(lesson.archived_at).toLocaleString()}
                            </dd>
                          </div>
                        )}

                        {/* Location & provenance — the Repo the lesson APPLIES
                            to (derived from the scope) plus where it was
                            RECORDED FROM (the PR / branch / commit the agent was
                            working in, migration 00048). The scope is passed to
                            `MemoryOrigin`/`originLinks` so these rows COMPLEMENT
                            the Repo row instead of repeating it: an origin the
                            Repo row already links (same repo, or a `branch::`
                            scope's own branch) is dropped. Timeline always
                            precedes it, so the first row starts a new cluster.
                            `MemoryOrigin` returns bare `div > dt/dd` rows, which
                            land as direct `dl` children here. */}
                        {(repoUrl || hasOrigin) && (
                          <>
                            {repoUrl && (
                              <div className={`flex items-center gap-2 text-xs ${clusterStart}`}>
                                <Github className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                                <dt className="text-[var(--color-content-tertiary)]">Repo</dt>
                                <dd className="ml-auto">
                                  <a
                                    href={repoUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-[var(--color-content-secondary)] hover:text-[var(--color-accent)] hover:underline transition-colors duration-150"
                                  >
                                    {repoDisplay}
                                  </a>
                                </dd>
                              </div>
                            )}
                            {/* `MemoryOrigin` returns a Fragment of bare
                                `div > dt/dd` rows, so it renders straight into
                                the `<dl>` as direct children — no wrapper, which
                                would push its pairs two levels below the `<dl>`
                                and break the `dl` content model. When there is a
                                Repo row it already carries the cluster's top
                                margin; when there isn't, the intra-cluster
                                `gap-2` still visually separates these rows from
                                the timeline above. */}
                            <MemoryOrigin origin={lesson} scope={lesson.scope} />
                          </>
                        )}
                      </dl>
                    );
                  })()}
                </section>
              </div>

              {/* Sticky footer — archive action + save/discard bar */}
              <div className="shrink-0">
                {/* Archive / restore button */}
                <div className="border-t border-[var(--color-border)] p-4">
                  <button
                    type="button"
                    onClick={handleArchive}
                    disabled={isPending || isSaving}
                    className={[
                      'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150',
                      isArchived
                        ? 'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-raised)]'
                        : 'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-400',
                      isPending || isSaving ? 'cursor-not-allowed opacity-50' : '',
                    ].join(' ')}
                  >
                    {isArchived ? (
                      <>
                        <RotateCcw className="size-4" aria-hidden />
                        {isPending ? 'Restoring…' : 'Restore'}
                      </>
                    ) : (
                      <>
                        <Archive className="size-4" aria-hidden />
                        {isPending ? 'Archiving…' : 'Archive'}
                      </>
                    )}
                  </button>
                </div>

                {/* Animated save/discard bar — appears only when form is dirty */}
                <FormActionBar
                  isDirty={isDirty && !isArchived}
                  isSaving={isSaving}
                  saveError={saveError}
                  onSave={handleSubmit}
                  onDiscard={discard}
                />
              </div>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
