import type { ReactNode } from 'react';

interface TutorialStepProps {
  number: number;
  title: string;
  children: ReactNode;
}

/**
 * A numbered step block for tutorial pages. Renders the step number as an
 * amber circle badge, the title in medium weight, and the body as children.
 * Keeps the visual language consistent across all tutorial pages without
 * repeating markup.
 */
export function TutorialStep({ number, title, children }: TutorialStepProps) {
  return (
    <div className="flex gap-4 pb-8">
      <div className="flex shrink-0 flex-col items-center">
        <span
          className="flex size-7 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-xs font-bold text-[var(--color-accent)]"
          aria-hidden
        >
          {number}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-2 text-sm font-medium text-[var(--color-content-primary)]">{title}</p>
        <div className="text-sm text-[var(--color-content-secondary)] [&_code]:rounded [&_code]:bg-[var(--color-bg-elevated)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-elevated)] [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs">
          {children}
        </div>
      </div>
    </div>
  );
}
