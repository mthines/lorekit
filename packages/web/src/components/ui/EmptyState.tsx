import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /**
   * An optional way OUT of the state, rendered under the description.
   *
   * An empty state that only explains is a dead end when the cause is a filter
   * the reader can lift. Naming the escape ("View all time") turns the message
   * into a recovery, which is the difference between a page that looks broken
   * and one that looks narrowed.
   */
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <Icon className="size-5 text-[var(--color-content-tertiary)]" aria-hidden />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-[var(--color-content-secondary)]">{title}</p>
        <p className="text-xs text-[var(--color-content-tertiary)]">{description}</p>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
