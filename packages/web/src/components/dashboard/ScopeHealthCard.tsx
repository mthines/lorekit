'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { FolderGit2, GitBranch, Globe, Layers, ArrowRight, BookOpen } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { ScopePrefix } from '@lorekit/core';

export interface ScopeHealth {
  scope: string;
  type: ScopePrefix;
  label: string;
  total: number;
  lastActivity: string | null; // ISO date
}

const SCOPE_ICONS: Record<ScopePrefix, typeof Globe> = {
  global: Globe,
  project: Layers,
  repo: FolderGit2,
  branch: GitBranch,
};

function freshnessLabel(lastActivity: string | null): { label: string; color: string } {
  if (!lastActivity) return { label: 'No activity', color: 'text-[var(--color-content-tertiary)]' };
  const days = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86_400_000);
  if (days === 0) return { label: 'Active today', color: 'text-[var(--color-success)]' };
  if (days < 7) return { label: `${days}d ago`, color: 'text-[var(--color-content-secondary)]' };
  if (days < 30) return { label: `${days}d ago`, color: 'text-[var(--color-warning)]' };
  return { label: `${days}d ago`, color: 'text-[var(--color-error)]' };
}

interface ScopeHealthCardProps {
  health: ScopeHealth;
  index: number;
}

export function ScopeHealthCard({ health, index }: ScopeHealthCardProps) {
  const Icon = SCOPE_ICONS[health.type];
  const freshness = freshnessLabel(health.lastActivity);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <Link
        href={`/lore?scope=${encodeURIComponent(health.scope)}`}
        className="group flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-elevated)] hover:shadow-[0_0_0_1px_var(--color-accent-glow)]"
        aria-label={`${health.label} — ${health.total} lessons, ${freshness.label}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] transition-colors duration-200 group-hover:border-[var(--color-accent-glow)] group-hover:bg-[var(--color-accent-subtle)]">
              <Icon className="size-4 text-[var(--color-content-secondary)] transition-colors duration-200 group-hover:text-[var(--color-accent)]" aria-hidden />
            </div>
            <Badge variant={health.type}>{health.type}</Badge>
          </div>
          <ArrowRight className="size-4 shrink-0 text-[var(--color-content-tertiary)] opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
        </div>

        {/* Label */}
        <div>
          <p className="truncate font-mono text-sm font-medium text-[var(--color-content-primary)]">
            {health.label}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-[var(--color-content-tertiary)]">
            {health.scope}
          </p>
        </div>

        {/* Stats */}
        <div className="flex items-end justify-between">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
              {health.total}
            </span>
            <span className="text-xs text-[var(--color-content-tertiary)]">
              lesson{health.total !== 1 ? 's' : ''}
            </span>
          </div>
          <span className={`text-xs ${freshness.color}`}>{freshness.label}</span>
        </div>
      </Link>
    </motion.div>
  );
}

interface ScopeHealthGridProps {
  scopes: ScopeHealth[];
}

export function ScopeHealthGrid({ scopes }: ScopeHealthGridProps) {
  if (scopes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] py-16 text-center">
        <BookOpen className="size-8 text-[var(--color-content-tertiary)]" aria-hidden />
        <div>
          <p className="text-sm text-[var(--color-content-secondary)]">No scopes yet</p>
          <p className="mt-1 text-xs text-[var(--color-content-tertiary)]">
            Run an agent with LoreKit configured to see your first scope here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="list"
      aria-label="Scope health cards"
    >
      {scopes.map((scope, i) => (
        <div key={scope.scope} role="listitem">
          <ScopeHealthCard health={scope} index={i} />
        </div>
      ))}
    </div>
  );
}
