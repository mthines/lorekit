'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Bot, Zap, Clock, CalendarClock, Archive, RotateCcw, Github } from 'lucide-react';
import { Controller } from 'react-hook-form';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { EditableField } from '@/components/ui/EditableField';
import { TagsField } from '@/components/ui/TagsField';
import { FormActionBar } from '@/components/ui/FormActionBar';
import { useEditableForm } from '@/lib/hooks/useEditableForm';
import { useArchiveLesson, useRestoreLesson } from '@/lib/queries/lore';
import type { LessonEntry } from './LessonCard';
import { updateLesson } from '@/lib/lore';
import { scopeRepoUrl } from '@/lib/scope';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LessonDetailSheetProps {
  lesson: LessonEntry | null;
  onClose: () => void;
  /** Called after a successful archive, restore, or save so the parent can refresh its list. */
  onMutated?: () => void;
}

interface LessonFormValues {
  value: string;
  tags: string[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LessonDetailSheet({ lesson, onClose, onMutated }: LessonDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const archiveMutation = useArchiveLesson();
  const restoreMutation = useRestoreLesson();
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  const isArchived = Boolean(lesson?.archived_at);

  // Derive default form values from the current lesson. Changing lesson (user
  // opens a different entry) resets the form automatically inside useEditableForm.
  const defaultValues = useMemo<LessonFormValues>(
    () => ({
      value: lesson?.value ?? '',
      tags: lesson?.tags ?? [],
    }),
    // Deliberately key on lesson identity (scope + key) so that opening the same
    // lesson again after a save does not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lesson?.scope, lesson?.key, lesson?.value, lesson?.tags],
  );

  const editForm = useEditableForm<LessonFormValues>({
    defaultValues,
    onSave: async (data) => {
      if (!lesson) return 'No lesson selected';
      const result = await updateLesson(lesson.scope, lesson.key, {
        value: data.value,
        tags: data.tags,
      });
      if (result.error) return result.error;
      // Show a success toast as the sidebar slides out. Fires concurrently with
      // onMutated() so the toast appears during the exit animation — a natural
      // confirmation that bridges the gap between "panel closed" and "did it save?".
      toast.success('Memory saved', {
        description: lesson.key,
      });
      onMutated?.();
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
            aria-label="Lesson detail"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] p-5">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <ScopeBadge scope={lesson.scope} type={lesson.scope_type} showPath linkRepo />
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
              aria-label="Edit lesson"
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
