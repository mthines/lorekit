import { describe, it, expect } from 'vitest';
import {
  tryParseJsonContainer,
  jsonNodeKind,
  jsonContainerSize,
  defaultExpandedPaths,
  allContainerPaths,
  jsonChildPath,
  JSON_TREE_ROOT_PATH,
} from './json-tree';

describe('tryParseJsonContainer', () => {
  it('parses a top-level object', () => {
    expect(tryParseJsonContainer('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a top-level array', () => {
    expect(tryParseJsonContainer('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('tolerates surrounding whitespace', () => {
    expect(tryParseJsonContainer('\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('rejects a bare string, number or boolean even though JSON.parse would accept them', () => {
    expect(tryParseJsonContainer('"just a string"')).toBeUndefined();
    expect(tryParseJsonContainer('42')).toBeUndefined();
    expect(tryParseJsonContainer('true')).toBeUndefined();
  });

  it('rejects plain markdown prose', () => {
    expect(tryParseJsonContainer('# Heading\n\nSome lesson body.')).toBeUndefined();
  });

  it('rejects empty / whitespace-only input', () => {
    expect(tryParseJsonContainer('')).toBeUndefined();
    expect(tryParseJsonContainer('   ')).toBeUndefined();
  });

  it('rejects malformed JSON that merely starts/ends with braces', () => {
    expect(tryParseJsonContainer('{not valid json}')).toBeUndefined();
  });

  it('rejects a fenced code block even when its body is JSON', () => {
    // A ```json fence isn't itself valid JSON — the outer text starts with a
    // backtick, not `{`/`[` — so it correctly falls through to markdown.
    expect(tryParseJsonContainer('```json\n{"a":1}\n```')).toBeUndefined();
  });
});

describe('jsonNodeKind', () => {
  it('identifies every kind', () => {
    expect(jsonNodeKind(null)).toBe('null');
    expect(jsonNodeKind([1])).toBe('array');
    expect(jsonNodeKind({ a: 1 })).toBe('object');
    expect(jsonNodeKind('s')).toBe('string');
    expect(jsonNodeKind(1)).toBe('number');
    expect(jsonNodeKind(true)).toBe('boolean');
  });
});

describe('jsonContainerSize', () => {
  it('counts array elements', () => {
    expect(jsonContainerSize([1, 2, 3])).toBe(3);
  });

  it('counts object keys', () => {
    expect(jsonContainerSize({ a: 1, b: 2 })).toBe(2);
  });

  it('is zero for a primitive', () => {
    expect(jsonContainerSize('hello')).toBe(0);
    expect(jsonContainerSize(null)).toBe(0);
  });
});

describe('jsonChildPath', () => {
  it('appends the key/index to the parent path with a NUL separator', () => {
    expect(jsonChildPath(JSON_TREE_ROOT_PATH, 'a')).toBe('\u0000a');
    expect(jsonChildPath('\u0000a', 0)).toBe('\u0000a\u00000');
  });
});

describe('defaultExpandedPaths', () => {
  const doc = { a: { b: { c: 1 } }, d: [1, 2, { e: 1 }] };

  it('always includes the root', () => {
    expect(defaultExpandedPaths(doc, 0).has(JSON_TREE_ROOT_PATH)).toBe(true);
  });

  it('expands only to the given depth', () => {
    const expanded = defaultExpandedPaths(doc, 1);
    expect(expanded.has(JSON_TREE_ROOT_PATH)).toBe(true);
    expect(expanded.has(jsonChildPath(JSON_TREE_ROOT_PATH, 'a'))).toBe(true);
    expect(expanded.has(jsonChildPath(JSON_TREE_ROOT_PATH, 'd'))).toBe(true);
    // depth 2 — one level past the requested depth — is not included.
    expect(expanded.has(jsonChildPath(jsonChildPath(JSON_TREE_ROOT_PATH, 'a'), 'b'))).toBe(false);
  });

  it('never includes a primitive leaf path', () => {
    const expanded = defaultExpandedPaths(doc, 10);
    const leafPath = jsonChildPath(
      jsonChildPath(jsonChildPath(JSON_TREE_ROOT_PATH, 'a'), 'b'),
      'c',
    );
    expect(expanded.has(leafPath)).toBe(false);
  });

  it('walks array indices as well as object keys', () => {
    const expanded = defaultExpandedPaths(doc, 10);
    expect(expanded.has(jsonChildPath(jsonChildPath(JSON_TREE_ROOT_PATH, 'd'), 2))).toBe(true);
  });
});

describe('allContainerPaths', () => {
  it('includes every nested container regardless of depth', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const expanded = allContainerPaths(deep);
    const deepestContainerPath = jsonChildPath(
      jsonChildPath(jsonChildPath(jsonChildPath(JSON_TREE_ROOT_PATH, 'a'), 'b'), 'c'),
      'd',
    );
    expect(expanded.has(deepestContainerPath)).toBe(true);
  });
});
