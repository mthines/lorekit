/**
 * Pure logic behind `JsonViewer` — detecting a JSON container in free-text
 * memory content and computing which of its nodes start expanded.
 *
 * Dependency-free with a co-located spec (the functional-core / impure-shell
 * split this package uses — see packages/web/CLAUDE.md). The component keeps
 * only rendering and per-node collapse toggling; parsing and the initial
 * expand set live here so they are unit-testable without a DOM.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Parse `raw` as JSON, but only return it when the top-level result is a
 * container (object or array). A bare string/number/boolean is valid JSON per
 * `JSON.parse` but isn't worth a fold/collapse tree — callers fall back to the
 * existing markdown preview for those (and for anything that fails to parse,
 * which is the common case: most memory values are prose).
 */
export function tryParseJsonContainer(raw: string): JsonValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Cheap pre-check before paying for a JSON.parse + try/catch on obviously
  // non-JSON prose — avoids running the parser on every keystroke of a long
  // markdown lesson body.
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== '{' || last !== '}') && (first !== '[' || last !== ']')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as JsonValue;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function jsonNodeKind(value: JsonValue): JsonNodeKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'null';
  }
}

/** Direct entry count of an object/array — the collapsed-row "3 items" summary. Non-containers have none. */
export function jsonContainerSize(value: JsonValue): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/** Stable id for the root node — every path id starts here and appends `\u0000<key>` per level. */
export const JSON_TREE_ROOT_PATH = '';

export function jsonChildPath(parentPath: string, key: string | number): string {
  return `${parentPath}\u0000${key}`;
}

/**
 * Which container node paths should start expanded, given a max depth (0 =
 * only the root). Depth-first so a wide but shallow document (many sibling
 * keys) and a narrow but deep one are both bounded by the same rule. Returns
 * path ids built with {@link jsonChildPath}, consumed as a `Set` by the
 * component so toggling one node is an O(1) add/delete.
 */
export function defaultExpandedPaths(value: JsonValue, maxDepth: number): Set<string> {
  const expanded = new Set<string>();
  function walk(node: JsonValue, path: string, depth: number): void {
    const kind = jsonNodeKind(node);
    if (kind !== 'object' && kind !== 'array') return;
    if (depth > maxDepth) return;
    expanded.add(path);
    if (kind === 'array') {
      (node as JsonValue[]).forEach((child, i) => walk(child, jsonChildPath(path, i), depth + 1));
    } else {
      Object.entries(node as Record<string, JsonValue>).forEach(([key, child]) =>
        walk(child, jsonChildPath(path, key), depth + 1),
      );
    }
  }
  walk(value, JSON_TREE_ROOT_PATH, 0);
  return expanded;
}

/** Every container path in the tree — what "Expand all" sets the expanded-path set to. */
export function allContainerPaths(value: JsonValue): Set<string> {
  return defaultExpandedPaths(value, Number.POSITIVE_INFINITY);
}
