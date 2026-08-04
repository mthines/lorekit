'use client';

/**
 * MemoryCard — the one component for rendering a memory (lesson).
 *
 * Every surface that shows a memory renders it through here so the key, scope
 * pill, value preview, agent/trigger metadata, timestamp, and tags stay
 * visually identical:
 *   - the Lore Explorer list        → `layout="card"`   (vertical, full detail)
 *   - the Activity feed rows        → `layout="row"`     (horizontal, leading icon)
 *   - the "N memories" dropdown     → `density="compact"` (key + one-line preview)
 *
 * Callers pass a normalised {@link MemoryCardModel}. The {@link memoryFromLesson}
 * adapter maps the app's `LessonEntry` shape onto it; build one inline for
 * anything else.
 */

import type { ReactNode } from 'react';
import { memo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Clock, Bot, Zap, Timer, GitPullRequest } from 'lucide-react';
import { ScopeBadge } from './ScopeBadge';
import { OwnershipBadge } from './OwnershipBadge';
import type { ScopePrefix } from './scope-meta';
import type { MemoryOwner } from '@/lib/ownership';
import { originPullRequestUrl } from '@/lib/origin';

// ── Model ───────────────────────────────────────────────────────────────────

/** Layout-agnostic shape every memory surface maps onto. */
export interface MemoryCardModel {
  scope: string;
  scopeType?: ScopePrefix;
  /** The lesson key (rendered as the title). */
  memoryKey: string;
  /** Full or already-truncated value text; the card clamps it visually. */
  preview: string;
  sourceAgent?: string | null;
  trigger?: string | null;
  tags?: string[];
  /** ISO timestamp shown as relative time. */
  timestamp?: string | null;
  archived?: boolean;
  /** Ownership — undefined for personal lore, `{id, name}` for org-owned lore. */
  org?: MemoryOwner;
  /** ISO expiry timestamp. Null/undefined = never expires. */
  expiresAt?: string | null;
  /**
   * GitHub pull-request link, derived from the origin (`origin_repo` + `origin_pr`).
   * Null when the memory has no PR provenance — the card shows the chip only when
   * both are present, so you can jump to the PR without opening the memory.
   */
  pr?: { url: string; label: string } | null;
}

/** Adapt a Lore Explorer lesson (LessonEntry-shaped) into the card model. */
export function memoryFromLesson(lesson: {
  scope: string;
  scope_type: ScopePrefix;
  key: string;
  value: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  source_agent?: string | null;
  trigger?: string | null;
  archived_at?: string | null;
  org?: MemoryOwner;
  expires_at?: string | null;
  origin_repo?: string | null;
  origin_pr?: number | null;
}): MemoryCardModel {
  // A PR chip needs both a valid repo and PR number; `originPullRequestUrl`
  // returns null unless both are present and well-formed.
  const prUrl = originPullRequestUrl(lesson);
  return {
    scope: lesson.scope,
    scopeType: lesson.scope_type,
    memoryKey: lesson.key,
    preview: lesson.value,
    sourceAgent: lesson.source_agent,
    trigger: lesson.trigger,
    tags: lesson.tags,
    // Date the card by creation date so a backdated (migrated) memory shows its
    // original time rather than the migration wall-clock.
    timestamp: lesson.created_at,
    archived: Boolean(lesson.archived_at),
    org: lesson.org,
    expiresAt: lesson.expires_at ?? null,
    pr: prUrl ? { url: prUrl, label: `#${lesson.origin_pr}` } : null,
  };
}

// ── Time ────────────────────────────────────────────────────────────────────

/** Shared relative-time formatter used by every memory surface. */
export function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function MetaChip({ icon: Icon, children }: { icon: typeof Bot; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

function Tags({ tags, max = 4 }: { tags: string[]; max?: number }) {
  if (tags.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {tags.slice(0, max).map((tag) => (
        <span
          key={tag}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-content-tertiary)]"
        >
          {tag}
        </span>
      ))}
      {tags.length > max && (
        <span className="rounded-md px-1.5 py-0.5 text-xs text-[var(--color-content-tertiary)]">
          +{tags.length - max}
        </span>
      )}
    </div>
  );
}

// ── ExpiryBadge ──────────────────────────────────────────────────────────────
// Shows a compact TTL pill on the card when expiry is within 30 days or past.
// Silent outside that window so cards with distant expiries stay uncluttered.

export function expiryStatus(iso: string | null | undefined): { label: string; urgent: boolean } | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(diff / 86_400_000);
  if (diff < 0)    return { label: 'Expired',       urgent: true  };
  if (days <= 1)   return { label: 'Expires today',  urgent: true  };
  if (days <= 7)   return { label: days + 'd left',  urgent: true  };
  if (days <= 30)  return { label: days + 'd left',  urgent: false };
  return null;
}

// `pointer-events-auto` is load-bearing: the card layout renders the badge inside
// a `pointer-events-none` body, which would also suppress the native `title`
// tooltip below. Re-enabling pointer events makes the badge its own hit target,
// so it forwards `onClick` to keep the whole-card "open" action intact.
function ExpiryBadge({ expiresAt, onClick }: { expiresAt?: string | null; onClick?: () => void }) {
  const status = expiryStatus(expiresAt);
  if (!status) return null;
  return (
    <span
      onClick={onClick}
      className={[
        'pointer-events-auto flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-xs',
        status.urgent
          ? 'border-amber-400/30 bg-amber-400/10 text-amber-400'
          : 'border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]',
      ].join(' ')}
      title={new Date(expiresAt!).toLocaleString()}
    >
      <Timer className="size-3" aria-hidden />
      {status.label}
    </span>
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface MemoryCardProps {
  memory: MemoryCardModel;
  /** Visual arrangement. @default 'card' */
  layout?: 'card' | 'row';
  /** `compact` collapses to key + one-line preview (dropdown rows). @default 'default' */
  density?: 'default' | 'compact';
  selected?: boolean;
  onClick?: () => void;
  /** Stagger index for the enter animation. */
  index?: number;
  /** Icon rendered in a bordered box before the content (row layout). */
  leadingIcon?: ReactNode;
  /** Scope pill. @default true (false in compact) */
  showScope?: boolean;
  /** Append the full canonical scope path in the footer. @default true in row layout */
  showScopePath?: boolean;
  /** Value preview. @default true */
  showPreview?: boolean;
  /** Agent / trigger metadata. @default true (false in compact) */
  showMeta?: boolean;
  /** Relative timestamp. @default true (false in compact) */
  showTimestamp?: boolean;
  /** Tag chips. @default true in card layout */
  showTags?: boolean;
  /** Enter animation. @default true (ignored in compact) */
  animate?: boolean;
  className?: string;
}

const SELECTED_CARD = 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]';

// ── Component ─────────────────────────────────────────────────────────────────

export const MemoryCard = memo(function MemoryCard({
  memory,
  layout = 'card',
  density = 'default',
  selected = false,
  onClick,
  index = 0,
  leadingIcon,
  showScope = true,
  showScopePath,
  showPreview = true,
  showMeta = true,
  showTimestamp = true,
  showTags = true,
  animate = true,
  className = '',
}: MemoryCardProps) {
  const reduceMotion = useReducedMotion();
  const {
    memoryKey,
    scope,
    scopeType: type,
    preview,
    sourceAgent,
    trigger,
    tags = [],
    timestamp,
    org,
    expiresAt,
    pr,
  } = memory;

  const keyCode = (
    <code
      className={[
        'truncate font-mono text-xs font-medium',
        selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-primary)]',
      ].join(' ')}
    >
      {memoryKey}
    </code>
  );

  const timeEl = showTimestamp && timestamp && (
    <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
      <Clock className="size-3" aria-hidden />
      {formatRelativeTime(timestamp)}
    </span>
  );

  // A real link (not nested in the card's open-button), so a click jumps to the
  // PR instead of opening the memory. `pointer-events-auto` lets it sit above
  // the card layout's stretched open-button overlay; `stopPropagation` is belt
  // and braces for the row layout where the whole card is still a button.
  const prChip = pr && (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Open pull request ${pr.label} on GitHub`}
      title={`Open pull request ${pr.label} on GitHub`}
      className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      <GitPullRequest className="size-3" aria-hidden />
      {pr.label}
    </a>
  );

  // ── Compact (dropdown row) ──────────────────────────────────────────────────
  // Mirrors the card/row element set (scope pill + key + preview + timestamp) at
  // list density. Selection is announced by the parent listbox option
  // (aria-selected), so the inner button omits aria-pressed to avoid a double
  // announcement.
  if (density === 'compact') {
    return (
      <button
        type="button"
        onClick={onClick}
        className={[
          'flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors duration-100',
          selected ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-bg-elevated)]',
          className,
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2">
          {keyCode}
          {showScope && <ScopeBadge scope={scope} type={type} label className="shrink-0" />}
        </div>
        {(showPreview || timeEl) && (
          <div className="flex items-center justify-between gap-2">
            {showPreview && (
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-content-tertiary)]">
                {preview}
              </span>
            )}
            {timeEl}
          </div>
        )}
      </button>
    );
  }

  const motionProps = animate
    ? {
        initial: { opacity: 0, y: reduceMotion ? 0 : 4 },
        animate: { opacity: 1, y: 0 },
        transition: { delay: index * 0.03, duration: 0.25, ease: 'easeOut' as const },
      }
    : {};

  // ── Row (activity feed) ─────────────────────────────────────────────────────
  if (layout === 'row') {
    // Scope is already shown as the pill in the header, so the canonical path is
    // off by default — opt in with showScopePath when the extra detail is wanted.
    const withPath = showScopePath ?? false;
    const hasMeta = showMeta && Boolean(sourceAgent || trigger);
    return (
      <motion.button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        {...motionProps}
        className={[
          'flex w-full gap-3 rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
          selected
            ? SELECTED_CARD
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:bg-[var(--color-bg-elevated)]',
          className,
        ].join(' ')}
      >
        {leadingIcon && (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
            {leadingIcon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {showScope && <ScopeBadge scope={scope} type={type} label />}
            <OwnershipBadge org={org} />
            {keyCode}
            {timeEl && <span className="ml-auto">{timeEl}</span>}
          </div>
          {showPreview && (
            <p className="mb-1.5 line-clamp-1 text-xs text-[var(--color-content-secondary)]">
              {preview}
            </p>
          )}
          {(hasMeta || withPath) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-content-tertiary)]">
              {showMeta && sourceAgent && <MetaChip icon={Bot}>{sourceAgent}</MetaChip>}
              {showMeta && trigger && <MetaChip icon={Zap}>{trigger}</MetaChip>}
              {withPath && (
                <ScopeBadge
                  scope={scope}
                  type={type}
                  showBadge={false}
                  showPath
                  className="ml-auto min-w-0"
                  pathClassName="opacity-50"
                />
              )}
            </div>
          )}
        </div>
      </motion.button>
    );
  }

  // ── Card (lore explorer) ────────────────────────────────────────────────────
  // Header mirrors the row layout — [scope pill] key … timestamp — so the card
  // and the activity row read the same; only the leading icon and density differ.
  //
  // The card root is a <div>, not a <button>, so the PR chip can be a real <a>
  // inside it — an anchor nested in a button is invalid HTML. The whole-card
  // "open" action is a stretched <button> overlay behind the content; the content
  // is pointer-events-none so clicks fall through to that button, except the two
  // elements that re-enable pointer events and sit on top: the PR chip (its own
  // link target) and the expiry badge (so its native tooltip still shows on
  // hover — it forwards the click back to the open action).
  const withPath = showScopePath ?? false;
  const hasMeta = showMeta && Boolean(sourceAgent || trigger);
  return (
    <motion.div
      {...motionProps}
      className={[
        'group relative w-full rounded-xl border transition-all duration-150',
        selected
          ? SELECTED_CARD
          : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:bg-[var(--color-bg-elevated)]',
        className,
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-label={`Open memory ${memoryKey}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      />
      <div className="pointer-events-none relative z-10 p-4 text-left">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {showScope && <ScopeBadge scope={scope} type={type} label />}
          <OwnershipBadge org={org} />
          {keyCode}
          <ExpiryBadge expiresAt={expiresAt} onClick={onClick} />
          {(prChip || timeEl) && (
            <span className="ml-auto flex items-center gap-1.5">
              {prChip}
              {timeEl}
            </span>
          )}
        </div>

        {showPreview && (
          <p className="mb-3 line-clamp-2 text-xs text-[var(--color-content-secondary)]">{preview}</p>
        )}

        {(hasMeta || withPath) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-content-tertiary)]">
            {showMeta && sourceAgent && <MetaChip icon={Bot}>{sourceAgent}</MetaChip>}
            {showMeta && trigger && <MetaChip icon={Zap}>{trigger}</MetaChip>}
            {withPath && (
              <ScopeBadge scope={scope} type={type} showBadge={false} showPath className="min-w-0" />
            )}
          </div>
        )}

        {showTags && <Tags tags={tags} />}
      </div>
    </motion.div>
  );
});
