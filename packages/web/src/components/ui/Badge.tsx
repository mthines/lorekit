import type { ReactNode } from 'react';

const VARIANT_STYLES = {
  global:  'bg-[#a78bfa1a] text-[var(--color-scope-global)]  border-[#a78bfa33]',
  project: 'bg-[#34d3991a] text-[var(--color-scope-project)] border-[#34d39933]',
  repo:    'bg-[#60a5fa1a] text-[var(--color-scope-repo)]    border-[#60a5fa33]',
  branch:  'bg-[#f5a6231a] text-[var(--color-scope-branch)]  border-[#f5a62333]',
  agent:   'bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] border-[var(--color-border)]',
  default: 'bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] border-[var(--color-border)]',
} as const;

type BadgeVariant = keyof typeof VARIANT_STYLES;

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-xs',
        VARIANT_STYLES[variant],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
