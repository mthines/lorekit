/**
 * Nest the flat `GET /memories/scopes` rows into the two-tier tree
 * `ScopeSelector` and `GroomingRuleBuilder`'s scope picker both already
 * expect: top-level scopes (repo / project / global) with branch scopes
 * hanging off their repo as `children`.
 *
 * Without this, a branch scope has nowhere to nest and lands in `nodes`
 * directly alongside every repo/project/global scope — which is exactly what
 * put one-off PR branches in the Explorer's persistent scope strip (the strip
 * renders whatever it's handed; it never re-derives a hierarchy itself).
 */
import { scopeRepoRef, scopeType } from './scope';
import type { ScopeNode } from '@/components/lore/ScopeTree';

export interface ScopeCount {
  scope: string;
  count: number;
}

function toNode({ scope, count }: ScopeCount): ScopeNode {
  const parts = scope.split('::');
  return { scope, type: scopeType(scope), label: parts[parts.length - 1] ?? scope, count };
}

export function buildScopeTree(rows: ScopeCount[]): ScopeNode[] {
  const top: ScopeNode[] = [];
  const byScope = new Map<string, ScopeNode>();
  const branches: ScopeNode[] = [];

  // Pass 1: every non-branch row is top-level, in the API's own order (count
  // desc, scope asc — see the comment above `fetchScopes`). Branches are set
  // aside; a repo they belong to may not have been seen yet.
  for (const row of rows) {
    const node = toNode(row);
    if (node.type === 'branch') {
      branches.push(node);
      continue;
    }
    top.push(node);
    byScope.set(node.scope, node);
  }

  // Pass 2: attach each branch to its repo. A malformed branch scope (should
  // never come from the API, but this stays total rather than throwing) is
  // surfaced top-level instead of silently dropped.
  for (const branch of branches) {
    const { repo } = scopeRepoRef(branch.scope);
    if (!repo) {
      top.push(branch);
      continue;
    }
    const parentScope = `repo::${repo}`;
    let parent = byScope.get(parentScope);
    if (!parent) {
      // No memory lives directly at repo scope — every one is under a branch.
      // Synthesize a zero-count parent so the branch stays reachable through
      // Browse all rather than vanishing (or landing in the strip on its
      // own). Appended after every real API row, since it wasn't one.
      parent = { scope: parentScope, type: 'repo', label: repo, count: 0 };
      byScope.set(parentScope, parent);
      top.push(parent);
    }
    (parent.children ??= []).push(branch);
  }

  return top;
}

/**
 * Every node in a scope tree, top-level and nested, in tree order (a node
 * before its own children). The one flatten used everywhere a caller needs
 * to search or total the WHOLE tree rather than just its top level —
 * `ScopeSelector`'s Browse-all list, the grooming page's scope combobox, and
 * the Explorer's total-count / selected-label lookups all used to hand-roll
 * this same recursion; a caller that reverted to `nodes.find(...)` or
 * `nodes.reduce(...)` would silently stop seeing anything nested.
 */
export function flattenScopeTree(nodes: ScopeNode[]): ScopeNode[] {
  const out: ScopeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) out.push(...flattenScopeTree(node.children));
  }
  return out;
}
