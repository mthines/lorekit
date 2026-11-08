/**
 * Record what changed in the page's DOM before React hydrated it, so a
 * hydration mismatch (React error #418) reaches RUM carrying the change that
 * caused it.
 *
 * ## Why this exists
 *
 * In November 2026 production RUM showed React #418 (`args[]=HTML`) on
 * `/blog/open-agent-memory-format` for 13 of 88 desktop Firefox sessions, and
 * for none of the ~430 Chrome, Safari, Edge or Firefox-for-Android sessions on
 * the same build. The server HTML and the client bundle are identical for every
 * browser and every client component on the page renders deterministically, so
 * the most likely cause is something in those browsers editing the DOM before
 * hydration — a translation feature or an extension. React's production error
 * names neither the component nor the node, so the telemetry could not say
 * which. This module records it.
 *
 * ## What counts as a change
 *
 * A change is counted only when React does not already own the node it
 * touches. React stamps a `__reactFiber$<random>` key on every node it hydrates
 * or creates (elements, text nodes, and the `<html>`/`<body>` singletons —
 * react-dom 19's `prepareToHydrateHostInstance`, `createTextNode` and singleton
 * paths). So:
 *
 * - Before hydration nothing is owned, and every change is recorded.
 * - A change to a node React has already claimed is skipped. It can no longer
 *   cause a hydration mismatch, and React's OWN later updates — the like count
 *   arriving, portals, Next's route announcer and `next/script` tags appended
 *   to the already-hydrated `<body>` — all land on owned nodes.
 *
 * That ownership test replaces any "hydration finished" signal, which the App
 * Router does not give: dehydrated Suspense boundaries can still hydrate (and
 * mismatch) after the root has committed and its effects have run.
 *
 * ## What is recorded — structure, never content
 *
 * Tag names, element ids, a three-level location (`main>article>p`) and the
 * `<html>` `lang`/`dir` values. Never text, attribute values from the body, or
 * class names (Tailwind class lists are long and say nothing about the cause).
 *
 * ## It rides on the hydration error only
 *
 * This module keeps a snapshot; `dash0-rum.ts` copies it onto signal
 * attributes only while the SDK records a hydration error, and removes them
 * straight after. A signal attribute describes the signal it rides on
 * (docs/otel.md, "These used to be signal attributes"), so the summary must
 * not label every web vital and request of the page load.
 *
 * Kept free of React, `next/*` and the SDK — `dash0-rum.ts` owns attaching the
 * snapshot, this module owns observing and describing.
 */

/** How long the watch observes before it stops itself; a hydration error does not end it. */
export const PREHYDRATION_WATCH_TIMEOUT_MS = 10_000;

/** Distinct entries kept in a summary before the rest are folded into a count. */
const MAX_SUMMARY_ENTRIES = 8;

/** Hard cap on the summary string, so one pathological page cannot bloat every signal. */
const MAX_SUMMARY_LENGTH = 512;

/** Ancestor levels shown in a change's location. */
const LOCATION_DEPTH = 3;

/** `<html>` attributes whose change says the browser rewrote the page's language. */
const OBSERVED_ROOT_ATTRIBUTES = ['lang', 'dir'];

/** Longest element id kept — ours are short heading ids; an injected node's may not be. */
const MAX_ID_LENGTH = 40;

/** Longest `lang`/`dir` value kept; real values are a few characters. */
const MAX_ATTRIBUTE_VALUE_LENGTH = 24;

/**
 * Matches the hydration errors React reports and nothing else: #418 (19.x,
 * any args) and #423/#425 from React 18, plus the unminified development
 * wording of each ("Hydration failed because…", "There was an error while
 * hydrating…", "Text content does not match server-rendered HTML"). A bare
 * "hydrat" would also catch an unrelated error that merely mentions it.
 */
const HYDRATION_ERROR_PATTERN =
  /Minified React error #(?:418|423|425)\b|Hydration failed|while hydrating|Text content does not match server-rendered HTML/i;

/** The prefix React gives the expando key it stamps on every node it owns. */
const REACT_FIBER_KEY_PREFIX = '__reactFiber$';

/** The parts of a `MutationRecord` this module reads. */
export type DomMutation = Pick<
  MutationRecord,
  'type' | 'target' | 'addedNodes' | 'removedNodes' | 'attributeName'
>;

/** What a {@link PrehydrationDomWatch} has recorded so far. */
export interface DomChangeSummary {
  /** Every change recorded so far, duplicates included. */
  count: number;
  /**
   * How many of those changes hydration cannot step over (see
   * {@link conflictingChangeCount}). Above 0, something other than React broke
   * the server HTML before React could claim it.
   */
  conflicting: number;
  /** De-duplicated, ordered, length-capped description of those changes; empty when `count` is 0. */
  summary: string;
}

/** Whether React has hydrated or created this node. */
export function isReactOwned(node: Node | null | undefined): boolean {
  if (!node) return false;
  for (const key of Object.keys(node)) {
    if (key.startsWith(REACT_FIBER_KEY_PREFIX)) return true;
  }
  return false;
}

/** Whether an error message is one of React's hydration-mismatch errors. */
export function isHydrationErrorMessage(message: unknown): boolean {
  return typeof message === 'string' && HYDRATION_ERROR_PATTERN.test(message);
}

/** Whether a window `error` event reports one of React's hydration-mismatch errors. */
export function isHydrationErrorEvent(event: Event): boolean {
  const { message, error } = event as ErrorEvent;
  return isHydrationErrorMessage(message) || isHydrationErrorMessage(messageOf(error));
}

/** `p`, `div#root`, `#text`, `#comment` — a node's tag and id, lower-cased. */
export function describeNode(node: Node): string {
  if (node.nodeType === 1) {
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    return element.id ? `${tag}#${element.id.slice(0, MAX_ID_LENGTH)}` : tag;
  }
  return node.nodeName.toLowerCase();
}

/**
 * Where a change happened: the nearest {@link LOCATION_DEPTH} elements from
 * `node` up, outermost first (`main>article>p`). Stops at `<body>`; a text
 * node starts from its parent element.
 */
export function describeLocation(node: Node | null): string {
  const path: string[] = [];
  let current: Node | null = node && node.nodeType !== 1 ? node.parentNode : node;
  while (current && current.nodeType === 1 && path.length < LOCATION_DEPTH) {
    path.push(describeNode(current));
    if ((current as Element).tagName === 'BODY') break;
    current = current.parentNode;
  }
  return path.length > 0 ? path.reverse().join('>') : '(detached)';
}

/**
 * Describe one mutation as zero or more summary entries, skipping anything
 * React already owns (see the module comment).
 *
 * - `+font in main>article>p` — a node was added there
 * - `-img in article>figure` — a node was removed from there
 * - `~#text in article>p` — a text node's content changed
 * - `html[lang]=fr` — the page's language was rewritten
 */
export function describeMutation(mutation: DomMutation): string[] {
  const { target } = mutation;

  if (mutation.type === 'attributes') {
    if (isReactOwned(target) || !mutation.attributeName) return [];
    const value = (target as Element).getAttribute(mutation.attributeName) ?? '';
    return [
      `${describeNode(target)}[${mutation.attributeName}]=${value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH)}`,
    ];
  }

  if (mutation.type === 'characterData') {
    // A string child of an element (`<p>{caption}</p>`) gets no fiber of its
    // own; React updates it through the owning element, so check the parent too.
    if (isReactOwned(target) || isReactOwned(target.parentNode)) return [];
    return [`~${describeNode(target)} in ${describeLocation(target)}`];
  }

  if (isReactOwned(target)) return [];
  const location = describeLocation(target);
  const entries: string[] = [];
  for (const node of Array.from(mutation.addedNodes)) {
    if (!isReactOwned(node)) entries.push(`+${describeNode(node)} in ${location}`);
  }
  for (const node of Array.from(mutation.removedNodes)) {
    if (!isReactOwned(node)) entries.push(`-${describeNode(node)} in ${location}`);
  }
  return entries;
}

/**
 * How many of a mutation's recorded changes (see {@link describeMutation}) can
 * make hydration fail.
 *
 * Two kinds cannot, so they are left out:
 *
 * - An attribute change. react-dom 19 leaves a mismatched attribute as it
 *   finds it and only warns in development, so `html[lang]=fr` never throws.
 * - A node added directly under `<body>`. react-dom 19 steps over unexpected
 *   children of `<body>` and `<head>` while hydrating, precisely because
 *   extensions put their widgets there (1Password, Grammarly and LastPass all
 *   do). Counting those would blame an extension for a mismatch that is ours.
 *
 * Everything else — a node added or removed inside the page, a text node
 * rewritten — leaves React looking at DOM the server did not send.
 */
export function conflictingChangeCount(mutation: DomMutation): number {
  if (mutation.type === 'attributes') return 0;
  const recorded = describeMutation(mutation).length;
  if (mutation.type !== 'childList' || !isBody(mutation.target)) return recorded;
  const addedUnderBody = Array.from(mutation.addedNodes).filter((node) => !isReactOwned(node));
  return recorded - addedUnderBody.length;
}

/** Whether a node is the document's `<body>`. */
function isBody(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).tagName === 'BODY';
}

/**
 * Fold counted entries into one line, in first-seen order:
 * `+font in main>article>p ×12; html[lang]=fr; …+3 more`.
 */
export function summarizeDomChanges(counts: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [entry, count] of counts) {
    if (parts.length === MAX_SUMMARY_ENTRIES) break;
    parts.push(count > 1 ? `${entry} ×${count}` : entry);
  }
  const hidden = counts.size - parts.length;
  if (hidden > 0) parts.push(`…+${hidden} more`);
  const summary = parts.join('; ');
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : summary;
}

export interface WatchOptions {
  /** The document to watch; defaults to the global one. */
  doc?: Document;
  /** Stop after this long. */
  timeoutMs?: number;
}

/** A running watch, read at the moment a hydration error is reported. */
export interface PrehydrationDomWatch {
  /**
   * The changes recorded so far, or `null` when the watch is not observing:
   * the parser is still running, or the watch has stopped. `{ count: 0 }`
   * means "observed, nothing changed" — a different answer from `null`.
   */
  snapshot(): DomChangeSummary | null;
  /** Stop observing. Idempotent; the watch also stops itself after `timeoutMs`. */
  stop(): void;
}

/**
 * Watch the document for changes React does not own, for
 * {@link PREHYDRATION_WATCH_TIMEOUT_MS} — long enough to cover hydration,
 * including Suspense boundaries that hydrate after the root.
 *
 * Observation starts once the parser has finished (`readyState` past
 * `loading`): before that, every element the parser appends is itself a
 * mutation, and a script that runs mid-parse would record the page. Until
 * then {@link PrehydrationDomWatch.snapshot} returns `null`, never a `0` that
 * would claim nothing changed.
 *
 * The snapshot holds only records the observer has already delivered. When
 * React reports a mismatch, the DOM work of its own client re-render sits in
 * that same task and is delivered afterwards, so it never reaches the
 * snapshot taken while the error is reported.
 *
 * @returns the watch, or `null` when the environment cannot observe the DOM
 *   (server render, no `MutationObserver`).
 */
export function watchPrehydrationDomChanges({
  doc = typeof document === 'undefined' ? undefined : document,
  timeoutMs = PREHYDRATION_WATCH_TIMEOUT_MS,
}: WatchOptions = {}): PrehydrationDomWatch | null {
  const win = doc?.defaultView;
  if (!doc || !win || typeof win.MutationObserver !== 'function') return null;
  const page: Document = doc;

  const counts = new Map<string, number>();
  let total = 0;
  let conflicting = 0;
  let observing = false;
  let stopped = false;

  const observer = new win.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const entry of describeMutation(mutation)) {
        counts.set(entry, (counts.get(entry) ?? 0) + 1);
        total++;
      }
      conflicting += conflictingChangeCount(mutation);
    }
  });

  const observe = () => {
    if (stopped || page.readyState === 'loading') return;
    page.removeEventListener('readystatechange', observe);
    observer.observe(page.documentElement, {
      attributes: true,
      attributeFilter: OBSERVED_ROOT_ATTRIBUTES,
    });
    if (page.body) {
      observer.observe(page.body, { childList: true, characterData: true, subtree: true });
    }
    observing = true;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    win.clearTimeout(deadline);
    page.removeEventListener('readystatechange', observe);
  };

  const deadline = win.setTimeout(stop, timeoutMs);
  if (page.readyState === 'loading') {
    page.addEventListener('readystatechange', observe);
  } else {
    observe();
  }

  return {
    snapshot: () =>
      observing && !stopped
        ? { count: total, conflicting, summary: summarizeDomChanges(counts) }
        : null,
    stop,
  };
}

/** The message of an `Error`-like value, if it has one. */
function messageOf(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
}
