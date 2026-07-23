'use client';

import { useState } from 'react';
import { ChevronRight, Globe, FolderGit2, GitBranch, Layers } from 'lucide-react';
import type { ScopePrefix } from '@lorekit/core';

export interface ScopeNode {
  scope: string;
  type: ScopePrefix;
  label: string;
  count: number;
  children?: ScopeNode[];
}

const SCOPE_ICONS: Record<ScopePrefix, typeof Globe> = {
  global: Globe,
  project: Layers,
  repo: FolderGit2,
  branch: GitBranch,
};

interface ScopeTreeItemProps {
  node: ScopeNode;
  depth: number;
  selected: string | null;
  onSelect: (scope: string) => void;
}

function ScopeTreeItem({ node, depth, selected, onSelect }: ScopeTreeItemProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const Icon = SCOPE_ICONS[node.type];
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isSelected = selected === node.scope;

  return (
    <li>
      <button
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
        aria-current={isSelected ? 'true' : undefined}
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
        <span className="ml-auto shrink-0 text-xs tabular-nums opacity-50">{node.count}</span>
      </button>

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
  selected: string | null;
  onSelect: (scope: string) => void;
}

export function ScopeTree({ nodes, selected, onSelect }: ScopeTreeProps) {
  return (
    <nav aria-label="Scope tree" className="flex flex-col gap-0.5 py-2">
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
    </nav>
  );
}
