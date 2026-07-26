'use client';

import { useState } from 'react';
import { ChevronRight, ExternalLink, LayoutList } from 'lucide-react';
import { scopeIcon } from '@/components/memory/scope-meta';
import { scopeRepoUrl, type ScopePrefix } from '@/lib/scope';

export interface ScopeNode {
  scope: string;
  type: ScopePrefix;
  label: string;
  count: number;
  children?: ScopeNode[];
}

interface ScopeTreeItemProps {
  node: ScopeNode;
  depth: number;
  selected: string | null;
  onSelect: (scope: string) => void;
}

function ScopeTreeItem({ node, depth, selected, onSelect }: ScopeTreeItemProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const Icon = scopeIcon(node.type);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isSelected = selected === node.scope;
  const repoUrl = scopeRepoUrl(node.scope);

  return (
    <li>
      {/* Row: the select button fills the width; the GitHub link is a sibling
          (not nested) so we never put an <a> inside a <button>. */}
      <div className="group/row relative flex items-center">
        <button
          type="button"
          onClick={() => {
            onSelect(node.scope);
            if (hasChildren) setExpanded((v) => !v);
          }}
          className={[
            'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-all duration-150',
            isSelected
              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
              : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
          ].join(' ')}
          style={{ paddingLeft: `${(depth + 1) * 12}px` }}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-selected={isSelected}
        >
          {hasChildren ? (
            <ChevronRight
              className={[
                'size-3 shrink-0 transition-transform duration-150',
                expanded ? 'rotate-90' : '',
              ].join(' ')}
              aria-hidden
            />
          ) : (
            <span className="size-3 shrink-0" aria-hidden />
          )}
          <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.label}</span>
          <span
            className={[
              'ml-auto shrink-0 text-xs tabular-nums opacity-50',
              repoUrl ? 'mr-6' : '',
            ].join(' ')}
          >
            {node.count}
          </span>
        </button>
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open ${node.label} on GitHub`}
            title="Open on GitHub"
            className="absolute right-2 flex size-5 items-center justify-center rounded text-[var(--color-content-tertiary)] opacity-0 transition-all duration-150 hover:text-[var(--color-content-primary)] focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>

      {hasChildren && expanded && (
        <ul className="mt-0.5" role="group">
          {node.children!.map((child) => (
            <ScopeTreeItem
              key={child.scope}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface ScopeTreeProps {
  nodes: ScopeNode[];
  /** The currently-selected scope, or null for "all scopes". */
  selected: string | null;
  onSelect: (scope: string | null) => void;
  /** Total active memory count across all scopes (for the "All" row). */
  totalCount?: number;
}

export function ScopeTree({ nodes, selected, onSelect, totalCount }: ScopeTreeProps) {
  const allSelected = selected === null;
  const allCount = totalCount ?? nodes.reduce((sum, n) => sum + n.count, 0);

  return (
    <nav aria-label="Scope tree" className="flex flex-col gap-0.5 py-2">
      {/* "All scopes" row — always first, selects null (no scope filter). */}
      <div className="px-1">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={[
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-all duration-150',
            allSelected
              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
              : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
          ].join(' ')}
          aria-selected={allSelected}
        >
          <span className="size-3 shrink-0" aria-hidden />
          <LayoutList className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">all</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums opacity-50">{allCount}</span>
        </button>
      </div>

      {nodes.length > 0 && (
        <>
          <div className="mx-3 my-1 border-t border-[var(--color-border)]" aria-hidden />
          <ul role="tree" aria-label="Memory scopes">
            {nodes.map((node) => (
              <ScopeTreeItem
                key={node.scope}
                node={node}
                depth={0}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
