'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Bot, Zap, Clock, CalendarClock, Archive, RotateCcw, Github, Users, UserCircle, Timer } from 'lucide-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { OwnershipBadge } from '@/components/memory/OwnershipBadge';
import { EditableField } from '@/components/ui/EditableField';
import { TagsField } from '@/components/ui/TagsField';
import { FormActionBar } from '@/components/ui/FormActionBar';
import { useEditableForm } from '@/lib/hooks/useEditableForm';
import { useArchiveLesson, useRestoreLesson } from '@/lib/queries/lore';
import type { LessonEntry } from './LessonCard';
import { updateLesson } from '@/lib/lore';
import { listMemberIdentities } from '@/lib/org-members';
import { scopeRepoUrl } from '@/lib/scope';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LessonDetailSheetProps {
  lesson: LessonEntry | null;
  onClose: () => void;
  /** Called after a successful archive, restore, or save so the parent can refresh its list. */
  onMutated?: () => void;
}

// TTL preset options shown in the expiry select. 0 means "never expires / clear".
const TTL_PRESETS = [
  { label: 'Never', days: 0 },
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;

interface LessonFormValues {
  value: string;
  tags: string[];
  /** Days until expiry. 0 = clear/never; null = unchanged. */
  ttlPreset: number | null;
  /** @deprecated kept to satisfy useEditableForm generic — no longer used. */
  customTtl: string;
}

// ── Component ─────────────────────────────────────────────────────────────────


// ── ExpiryControl ────────────────────────────────────────────────────────────
// Inline TTL picker. Uses native <select> + conditional number input (no extra
// deps). Sits in the metadata section. Changes mark the form dirty so the
// existing save/discard bar handles confirmation and submission.

interface ExpiryControlProps {
  currentExpiresAt?: string | null;
  form: UseFormReturn<LessonFormValues>;
  disabled?: boolean;
}

function ExpiryControl({ currentExpiresAt, form, disabled }: ExpiryControlProps) {
  const ttlPreset = form.watch('ttlPreset');

  const isExpired = currentExpiresAt ? new Date(currentExpiresAt) < new Date() : false;

  // The sentinel value used in the select when the memory has a custom/unknown
  // TTL that doesn't match any preset. The user can see the current formatted
  // date in this option; selecting a preset replaces it.
  const CURRENT_SENTINEL = '__current__';

  // Determine whether the current expires_at matches one of the known presets
  // (approximate: within ±12 h of the expected target date). If it does, we
  // can pre-select that preset; otherwise fall back to __current__.
  const matchedPreset = (() => {
    if (!currentExpiresAt) return 0; // Never
    if (isExpired) return null;
    const expiresMs = new Date(currentExpiresAt).getTime();
    for (const p of TTL_PRESETS) {
      if (p.days === 0) continue;
      const expected = Date.now() + p.days * 86_400_000;
      if (Math.abs(expiresMs - expected) < 12 * 3_600_000) return p.days;
    }
    return null; // custom / doesn't match any preset
  })();

  // The value driving the <select>:
  //   ttlPreset !== null → user has explicitly chosen something this session
  //   ttlPreset === null → reflect the current persisted state
  const selectValue = ttlPreset !== null
    ? String(ttlPreset)
    : matchedPreset !== null
      ? String(matchedPreset)
      : CURRENT_SENTINEL;

  // Human-readable label for the __current__ option (shown when the TTL
  // doesn't match a preset — e.g. a custom value set via MCP).
  const currentLabel = isExpired
    ? 'Expired'
    : currentExpiresAt
      ? new Date(currentExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Never';

  return (
    <select
      aria-label="Expiry"
      disabled={disabled}
      value={selectValue}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === CURRENT_SENTINEL) return; // selecting "current" is a no-op
        const val = Number(raw);
        form.setValue('ttlPreset', val, { shouldDirty: true });
      }}
      className={[
        'cursor-pointer bg-transparent text-xs focus:outline-none disabled:cursor-default disabled:opacity-50',
        isExpired
          ? 'text-amber-400'
          : 'text-[var(--color-content-secondary)]',
      ].join(' ')}
    >
      {/* Shown only when the stored TTL doesn't match a preset */}
      {matchedPreset === null && (
        <option value={CURRENT_SENTINEL} disabled>
          {currentLabel}
        </option>
      )}
      {TTL_PRESETS.map((p) => (
        <option key={p.days} value={String(p.days)}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

export function LessonDetailSheet({ lesson, onClose, onMutated }: LessonDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
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
      ttlPreset: null,   // null = "don't touch the TTL this save"
      customTtl: '',
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
      // Derive TTL params from the preset selection.
      let ttlDays: number | null = null;
      let clearTtl = false;
      if (data.ttlPreset === 0) {
        clearTtl = true;
      } else if (data.ttlPreset !== null && data.ttlPreset > 0) {
        ttlDays = data.ttlPreset;
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
      // panel without requiring a page refresh.
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['lore'] });
      toast.success('Memory saved', { description: lesson.key });
    },
  });

  const { form, isSaving, saveError, isDirty, handleSubmit, discard } = editForm;

  // Focus close button on open; restore on close.
  useEffect(() => {
    if (lesson) {
      const timer = setTimeout(() => closeRef.current?.focus(), 80);
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Panel — slides in from right */}
          <motion.aside
            key="panel"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Memory detail"
          >
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
              className="flex flex-1 flex-col overflow-hidden"
              aria-label="Edit memory"
            >
              <div className="group flex flex-1 flex-col gap-5 overflow-y-auto p-5">
                {/* Content — editable */}
                <Controller
                  name="value"
                  control={form.control}
                  rules={{ required: 'Content is required', minLength: { value: 1, message: 'Content cannot be empty' } }}
                  render={({ field, fieldState }) => (
                    <EditableField
                      label="Content"
                      value={field.value}
                      onChange={field.onChange}
                      onEditEnd={field.onBlur}
                      isEditing={!isArchived}
                      readOnly={isArchived}
                      placeholder="Enter memory content…"
                      minRows={4}
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
                  <dl className="flex flex-col gap-2">
                    {/* Ownership (org-owned lore only) — Owner, last-updated-by
                        author, and "Visible to N members", resolved from the
                        Phase 4 identity RPC above. */}
                    {lesson.org && (
                      <div className="flex items-center gap-2 text-xs">
                        <Users className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Owner</dt>
                        <dd className="ml-auto font-medium text-[var(--color-content-secondary)]">
                          {lesson.org.name}
                        </dd>
                      </div>
                    )}
                    {lesson.org && (
                      <div className="flex items-center gap-2 text-xs">
                        <UserCircle className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Last updated by</dt>
                        <dd className="ml-auto text-[var(--color-content-secondary)]">
                          {updatedByHandle ? `@${updatedByHandle}` : 'a team member'}
                        </dd>
                      </div>
                    )}
                    {lesson.org && memberCount !== null && (
                      <div className="flex items-center gap-2 text-xs">
                        <Users className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Visible to</dt>
                        <dd className="ml-auto text-[var(--color-content-secondary)]">
                          {memberCount} {memberCount === 1 ? 'member' : 'members'}
                        </dd>
                      </div>
                    )}
                    {lesson.source_agent && (
                      <div className="flex items-center gap-2 text-xs">
                        <Bot className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Source agent</dt>
                        <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                          {lesson.source_agent}
                        </dd>
                      </div>
                    )}
                    {lesson.trigger && (
                      <div className="flex items-center gap-2 text-xs">
                        <Zap className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Trigger</dt>
                        <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                          {lesson.trigger}
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs">
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
                      <div className="flex items-center gap-2 text-xs">
                        <Timer className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                        <dt className="text-[var(--color-content-tertiary)]">Expires</dt>
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
                    {(() => {
                      const repoUrl = scopeRepoUrl(lesson.scope);
                      if (!repoUrl) return null;
                      const display = lesson.scope.replace(/^(repo|branch)::/, '');
                      return (
                        <div className="flex items-center gap-2 text-xs">
                          <Github className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                          <dt className="text-[var(--color-content-tertiary)]">Repo</dt>
                          <dd className="ml-auto">
                            <a
                              href={repoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[var(--color-content-secondary)] hover:text-[var(--color-accent)] hover:underline transition-colors duration-150"
                            >
                              {display}
                            </a>
                          </dd>
                        </div>
                      );
                    })()}
                  </dl>
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
