import type { ReactNode } from 'react';

type CalloutVariant = 'info' | 'tip' | 'warning';

interface TutorialCalloutProps {
  variant?: CalloutVariant;
  children: ReactNode;
}

const STYLES: Record<CalloutVariant, { border: string; bg: string; label: string }> = {
  info: {
    border: 'border-[var(--color-border)]',
    bg: 'bg-[var(--color-bg-elevated)]',
    label: 'Note',
  },
  tip: {
    border: 'border-[var(--color-accent)]',
    bg: 'bg-[var(--color-accent-subtle)]',
    label: 'Tip',
  },
  warning: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/5',
    label: 'Note',
  },
};

/**
 * A callout block for tutorial pages. Renders a left-border accent box
 * with an optional variant label. Keeps the visual language consistent
 * without repeating markup.
 */
export function TutorialCallout({ variant = 'info', children }: TutorialCalloutProps) {
  const { border, bg, label } = STYLES[variant];
  return (
    <div
      className={[
        'my-4 rounded-lg border-l-4 p-4 text-sm',
        border,
        bg,
      ].join(' ')}
      role="note"
    >
      <span className="mr-1 font-semibold text-[var(--color-content-primary)]">{label}:</span>
      <span className="text-[var(--color-content-secondary)]">{children}</span>
    </div>
  );
}
