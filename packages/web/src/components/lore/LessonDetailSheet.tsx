'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Bot, Zap, Tag, Clock, CalendarClock, Archive, RotateCcw, Users, UserCircle } from 'lucide-react';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { OwnershipBadge } from '@/components/memory/OwnershipBadge';
import type { LessonEntry } from './LessonCard';
import { archiveLesson, restoreLesson } from '@/lib/lore';
import { listMembers } from '@/lib/orgs';
import { listMemberIdentities } from '@/lib/org-members';

interface LessonDetailSheetProps {
  lesson: LessonEntry | null;
  onClose: () => void;
  /** Called after a successful archive or restore so the parent can refresh its list. */
  onMutated?: () => void;
}

export function LessonDetailSheet({ lesson, onClose, onMutated }: LessonDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [updatedByHandle, setUpdatedByHandle] = useState<string | null>(null);

  const isArchived = Boolean(lesson?.archived_at);

  // Org-owned lore: resolve "Visible to N members" (D8 — reuses listMembers)
  // and, where resolvable, the last-updated-by author's real GitHub handle
  // via the Phase 4 `lorekit_org_members_list` identity RPC. Falls back to a
  // generic "a team member" when the author can't be resolved (e.g. they've
  // since left the org) — never fabricates a handle.
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
      const [members, identities] = await Promise.all([
        listMembers(org.id),
        listMemberIdentities(org.id),
      ]);
      if (cancelled) return;
      setMemberCount(members.length);
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

  // Focus close button on open; restore on close
  useEffect(() => {
    if (lesson) {
      const timer = setTimeout(() => closeRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [lesson]);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && lesson) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lesson, onClose]);

  function handleArchive() {
    if (!lesson) return;
    setActionError(null);
    startTransition(async () => {
      const result = isArchived
        ? await restoreLesson(lesson.scope, lesson.key)
        : await archiveLesson(lesson.scope, lesson.key);
      if (result.error) {
        setActionError(result.error);
      } else {
        onMutated?.();
        onClose();
      }
    });
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
                  <ScopeBadge scope={lesson.scope} type={lesson.scope_type} showPath />
                  <OwnershipBadge org={lesson.org} />
                  {isArchived && (
                    <span className="rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)]">
                      archived
                    </span>
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

            {/* Body */}
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
              {/* Value */}
              <section aria-label="Lesson content">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                  Content
                </h2>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre-wrap">
                  {lesson.value}
                </div>
              </section>

              {/* Metadata */}
              <section aria-label="Metadata">
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                  Metadata
                </h2>
                <dl className="flex flex-col gap-2">
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
                  {lesson.archived_at && (
                    <div className="flex items-center gap-2 text-xs">
                      <Archive className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                      <dt className="text-[var(--color-content-tertiary)]">Archived</dt>
                      <dd className="ml-auto text-[var(--color-content-secondary)]">
                        {new Date(lesson.archived_at).toLocaleString()}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>

              {/* Tags */}
              {lesson.tags.length > 0 && (
                <section aria-label="Tags">
                  <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                    <Tag className="size-3" aria-hidden />
                    Tags
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {lesson.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--color-content-secondary)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Footer — actions */}
            <div className="border-t border-[var(--color-border)] p-4 flex flex-col gap-2">
              {actionError && (
                <p className="text-xs text-red-500">{actionError}</p>
              )}
              <button
                type="button"
                onClick={handleArchive}
                disabled={isPending}
                className={[
                  'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150',
                  isArchived
                    ? 'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-raised)]'
                    : 'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-400',
                  isPending ? 'cursor-not-allowed opacity-50' : '',
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
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
