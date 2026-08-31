'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, Copy, Check, ListTree, ListCollapse } from 'lucide-react';
import {
  jsonChildPath,
  jsonContainerSize,
  jsonNodeKind,
  defaultExpandedPaths,
  allContainerPaths,
  JSON_TREE_ROOT_PATH,
  type JsonValue,
} from '@/lib/json-tree';

/**
 * JsonViewer
 *
 * A read-only, foldable tree view for a parsed JSON value — used by
 * `LessonDetailSheet`'s Content preview when a memory's value is itself a
 * JSON document (common for `kind: bus` events and automation payloads),
 * instead of dumping it as one unstructured fenced code block.
 *
 * - **Fold/collapse** per object/array node, `Set<path>` state driven by the
 *   pure helpers in `lib/json-tree.ts` (parsing, depth walk, path ids) — this
 *   component owns only the toggling and rendering.
 * - **Expand all / Collapse all** for the whole tree.
 * - **Copy** — a root-level "Copy JSON" button, plus a per-row copy icon
 *   (revealed on hover/focus) that copies just that node's `JSON.stringify`d
 *   value, so a user can grab one nested field without hand-selecting text
 *   through a folding editor.
 *
 * Two levels open by default — enough to orient on the document's shape
 * without a 1000-line memory payload paging the sheet on open.
 */

const DEFAULT_EXPAND_DEPTH = 2;

export interface JsonViewerProps {
  value: JsonValue;
  className?: string;
}

export function JsonViewer({ value, className = '' }: JsonViewerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpandedPaths(value, DEFAULT_EXPAND_DEPTH),
  );

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div className={['rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]', className].join(' ')}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-2 py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded(allContainerPaths(value))}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-content-secondary)]"
          >
            <ListTree className="size-3" aria-hidden />
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setExpanded(new Set([JSON_TREE_ROOT_PATH]))}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-content-secondary)]"
          >
            <ListCollapse className="size-3" aria-hidden />
            Collapse all
          </button>
        </div>
        <CopyButton value={value} label="Copy JSON" />
      </div>
      <div className="overflow-x-auto p-2 font-mono text-xs leading-relaxed">
        <JsonNode
          nodeKey={null}
          value={value}
          path={JSON_TREE_ROOT_PATH}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          isLast
        />
      </div>
    </div>
  );
}

// ── CopyButton ──────────────────────────────────────────────────────────────
// Shared per-node / root copy affordance. Mirrors the copy pattern used
// elsewhere in the dashboard (e.g. `CopyCommand`): optimistic "Copied" state,
// clipboard failure caught silently since the value is still visible/selectable.

function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: JsonValue;
  label: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    const text = JSON.stringify(value, null, 2);
    // Start from a resolved promise so a synchronous throw (clipboard API
    // absent in an insecure context) becomes a rejection instead of an
    // uncaught exception — see `CopyCommand` for the same reasoning.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard unavailable or denied — the value remains visible/selectable.
      });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={[
        'flex shrink-0 items-center gap-1 rounded-md text-[10px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
        compact ? 'p-1' : 'px-1.5 py-1',
      ].join(' ')}
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {!compact && (copied ? 'Copied' : label)}
    </button>
  );
}

// ── JsonNode ─────────────────────────────────────────────────────────────────

const PUNCTUATION = 'text-[var(--color-content-tertiary)]';
const KEY_COLOR = 'text-[var(--color-accent)]';
const STRING_COLOR = 'text-emerald-400';
const NUMBER_COLOR = 'text-sky-400';
const BOOLEAN_COLOR = 'text-purple-400';
const NULL_COLOR = 'text-[var(--color-content-tertiary)] italic';

interface JsonNodeProps {
  /** The object key or array index this node was reached under; `null` at the root. */
  nodeKey: string | number | null;
  value: JsonValue;
  path: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  /** Suppresses the trailing comma after the last sibling in a container. */
  isLast: boolean;
}

function JsonNode({ nodeKey, value, path, depth, expanded, onToggle, isLast }: JsonNodeProps) {
  const kind = jsonNodeKind(value);
  const isContainer = kind === 'object' || kind === 'array';
  const isOpen = isContainer && expanded.has(path);
  const size = isContainer ? jsonContainerSize(value) : 0;

  const keyPrefix =
    nodeKey === null ? null : (
      <>
        {typeof nodeKey === 'string' && <span className={KEY_COLOR}>&quot;{nodeKey}&quot;</span>}
        {typeof nodeKey === 'number' && <span className={PUNCTUATION}>{nodeKey}</span>}
        <span className={PUNCTUATION}>: </span>
      </>
    );

  if (!isContainer) {
    return (
      <div
        className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-[var(--color-bg-raised)]"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="min-w-0 flex-1 break-all">
          {keyPrefix}
          <PrimitiveValue kind={kind} value={value} />
          {!isLast && <span className={PUNCTUATION}>,</span>}
        </span>
        <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <CopyButton value={value} label="Copy value" compact />
        </span>
      </div>
    );
  }

  const openBracket = kind === 'array' ? '[' : '{';
  const closeBracket = kind === 'array' ? ']' : '}';
  const entries: Array<[string | number, JsonValue]> =
    kind === 'array'
      ? (value as JsonValue[]).map((v, i) => [i, v])
      : Object.entries(value as Record<string, JsonValue>);

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-[var(--color-bg-raised)]"
        style={{ paddingLeft: depth * 14 }}
      >
        <button
          type="button"
          onClick={() => onToggle(path)}
          aria-expanded={isOpen}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
          className="-mt-0.5 flex size-6 shrink-0 items-center justify-center text-[var(--color-content-tertiary)] transition-transform duration-150"
        >
          <ChevronRight
            className={['size-3', isOpen ? 'rotate-90' : ''].join(' ')}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={() => onToggle(path)}
          className="min-w-0 flex-1 text-left"
        >
          {keyPrefix}
          <span className={PUNCTUATION}>{openBracket}</span>
          {!isOpen && (
            <>
              <span className="mx-1 text-[var(--color-content-tertiary)]">
                {size === 0 ? '' : `${size} ${kind === 'array' ? (size === 1 ? 'item' : 'items') : size === 1 ? 'key' : 'keys'}`}
              </span>
              <span className={PUNCTUATION}>{closeBracket}</span>
              {!isLast && <span className={PUNCTUATION}>,</span>}
            </>
          )}
        </button>
        <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <CopyButton value={value} label="Copy value" compact />
        </span>
      </div>
      {isOpen && (
        <>
          {entries.map(([childKey, childValue], i) => (
            <JsonNode
              key={childKey}
              nodeKey={childKey}
              value={childValue}
              path={jsonChildPath(path, childKey)}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className={PUNCTUATION} style={{ paddingLeft: depth * 14 + 14 }}>
            {closeBracket}
            {!isLast && ','}
          </div>
        </>
      )}
    </div>
  );
}

function PrimitiveValue({ kind, value }: { kind: JsonNodeKindLocal; value: JsonValue }) {
  switch (kind) {
    case 'string':
      return <span className={STRING_COLOR}>&quot;{String(value)}&quot;</span>;
    case 'number':
      return <span className={NUMBER_COLOR}>{String(value)}</span>;
    case 'boolean':
      return <span className={BOOLEAN_COLOR}>{String(value)}</span>;
    case 'null':
      return <span className={NULL_COLOR}>null</span>;
    default:
      return null;
  }
}

// Narrowed alias — `PrimitiveValue` only ever receives a non-container kind.
type JsonNodeKindLocal = 'string' | 'number' | 'boolean' | 'null';
