import { describe, it, expect } from 'vitest';
import { buildScopeTree, flattenScopeTree } from './scope-tree';

describe('buildScopeTree', () => {
  it('keeps non-branch scopes top-level, in the given order', () => {
    const tree = buildScopeTree([
      { scope: 'repo::mthines/lorekit', count: 10 },
      { scope: 'global', count: 5 },
      { scope: 'project::widget', count: 2 },
    ]);
    expect(tree.map((n) => n.scope)).toEqual(['repo::mthines/lorekit', 'global', 'project::widget']);
    expect(tree.every((n) => n.children === undefined)).toBe(true);
  });

  it('nests a branch under its existing repo node', () => {
    const tree = buildScopeTree([
      { scope: 'repo::dash0hq/dash0', count: 3 },
      { scope: 'branch::dash0hq/dash0::feat/x', count: 1 },
    ]);
    expect(tree).toHaveLength(1);
    const repo = tree[0]!;
    expect(repo.scope).toBe('repo::dash0hq/dash0');
    expect(repo.count).toBe(3); // the repo's own count is untouched by nesting
    expect(repo.children?.map((c) => c.scope)).toEqual(['branch::dash0hq/dash0::feat/x']);
  });

  it('synthesizes a zero-count parent when no memory lives directly at repo scope', () => {
    const tree = buildScopeTree([{ scope: 'branch::dash0hq/dash0::feat/x', count: 1 }]);
    expect(tree).toHaveLength(1);
    const repo = tree[0]!;
    expect(repo).toMatchObject({ scope: 'repo::dash0hq/dash0', type: 'repo', label: 'dash0hq/dash0', count: 0 });
    expect(repo.children?.map((c) => c.scope)).toEqual(['branch::dash0hq/dash0::feat/x']);
  });

  it('groups multiple branches of the same repo under one parent', () => {
    const tree = buildScopeTree([
      { scope: 'branch::dash0hq/dash0::feat/x', count: 1 },
      { scope: 'branch::dash0hq/dash0::feat/y', count: 2 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children?.map((c) => c.scope)).toEqual([
      'branch::dash0hq/dash0::feat/x',
      'branch::dash0hq/dash0::feat/y',
    ]);
  });

  it('keeps branches of different repos under separate parents', () => {
    const tree = buildScopeTree([
      { scope: 'branch::mthines/lorekit::feat/a', count: 1 },
      { scope: 'branch::dash0hq/dash0::feat/b', count: 1 },
    ]);
    expect(tree.map((n) => n.scope).sort()).toEqual(['repo::dash0hq/dash0', 'repo::mthines/lorekit']);
  });

  it('is total: a malformed branch scope surfaces top-level rather than throwing', () => {
    const tree = buildScopeTree([{ scope: 'branch::not-a-valid-repo', count: 1 }]);
    expect(tree.map((n) => n.scope)).toEqual(['branch::not-a-valid-repo']);
  });
});

describe('flattenScopeTree', () => {
  it('returns every node, parent before its children', () => {
    const tree = buildScopeTree([
      { scope: 'global', count: 5 },
      { scope: 'repo::dash0hq/dash0', count: 3 },
      { scope: 'branch::dash0hq/dash0::feat/x', count: 1 },
    ]);
    expect(flattenScopeTree(tree).map((n) => n.scope)).toEqual([
      'global',
      'repo::dash0hq/dash0',
      'branch::dash0hq/dash0::feat/x',
    ]);
  });

  it('sums to the same total the pre-nesting flat list would have', () => {
    const rows = [
      { scope: 'global', count: 5 },
      { scope: 'repo::dash0hq/dash0', count: 3 },
      { scope: 'branch::dash0hq/dash0::feat/x', count: 1 },
      { scope: 'branch::dash0hq/dash0::feat/y', count: 2 },
    ];
    const tree = buildScopeTree(rows);
    const total = flattenScopeTree(tree).reduce((sum, n) => sum + n.count, 0);
    expect(total).toBe(rows.reduce((sum, r) => sum + r.count, 0));
  });
});
