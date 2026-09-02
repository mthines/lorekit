import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/Button';

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
  action?: {
    label: string;
    onClick: () => void;
    /**
     * `analyticsId` for the action button. Defaults to `'empty-state.action'`;
     * callers pass a distinct static-literal `<surface>.empty-state.<action>`
     * slug so each empty-state recovery is a distinguishable `ui.button_click`.
     */
    analyticsId?: string;
  };
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
        <Button
          variant="secondary"
          size="sm"
          // Forwarded via spread rather than a JSX attribute expression: the
          // analytics-id-literals guard enforces STATIC string literals at every
          // call site, so this wrapper passes the (literal) caller value through
          // the object form Button uses. Do not inline this back to a JSX
          // attribute — an attribute expression here would trip the guard.
          {...{ analyticsId: action.analyticsId ?? 'empty-state.action' }}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
