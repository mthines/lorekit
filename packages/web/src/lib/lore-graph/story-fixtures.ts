/**
 * Synthetic accounts for the memory-map stories.
 *
 * Separate from `fixtures.ts` on purpose. That file owns ONE shape — the
 * plan-ceiling account whose exact moduli calibrate both `build.spec.ts`'s work
 * bound and the published benchmark figure, and which therefore must not be
 * edited casually. These are the opposite: a deliberately wide set of shapes
 * chosen to make each of the map's visual states reachable in Storybook,
 * including the ones a healthy account never produces.
 *
 * Everything here is DETERMINISTIC. No `Math.random`, no `Date.now`, no
 * `crypto.randomUUID` — a story whose data differs per render cannot be
 * compared to itself, and the layout's whole stability claim (`layout.ts`:
 * a memory's bearing is a hash of its id) is only observable if the ids are the
 * same on every load.
 */

import type { GraphMemoryInput } from './build';

/** Frozen so `updated_at` never drifts, and so the fixtures age consistently. */
export const STORY_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

/** `n` days before {@link STORY_NOW}, as an ISO instant. */
function daysAgo(days: number): string {
  return new Date(STORY_NOW - days * 86_400_000).toISOString();
}

/**
 * A deterministic integer stream.
 *
 * Fixtures need *variety* — clusters of different sizes, a scatter of ages —
 * without randomness. A 32-bit LCG gives a spread that looks organic and is
 * byte-identical on every machine and every reload.
 */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

/** The scope shapes a real account mixes, in rough order of population. */
const SCOPES = [
  'global',
  'repo::mthines/lorekit',
  'repo::mthines/agent-skills',
  'repo::mthines/gw-tools',
  'project::dash0',
  'branch::mthines/lorekit::feat/lore-graph',
] as const;

/** The loop buckets LoreKit's own agents actually write to. */
const BUCKETS = [
  'aw-lessons',
  'reviewer-lessons',
  'ci-auto-fix-lessons',
  'implement-suggestion-lessons',
  'test-auto-fix-lessons',
  'fix-bug-lessons',
] as const;

const TOPICS = [
  'ci',
  'flaky',
  'migrations',
  'supabase',
  'react-effect-state',
  'telemetry',
  'accessibility',
  'perf',
  'docs-drift',
  'test-quality',
  'browser-lifecycle',
  'packaging',
] as const;

export interface RealisticAccountOptions {
  /** How many memories to generate. */
  count?: number;
  /** How many of the scope shapes to spread them over. */
  scopes?: number;
  /** Fraction (0–1) that carry `archived_at`, so the dimmed state is reachable. */
  archivedShare?: number;
  /** Fraction (0–1) that carry a `seen_count` above 1, so radius varies. */
  recurringShare?: number;
  /** Add a label carried by EVERY memory, so hub suppression fires. */
  withHubLabel?: boolean;
}

/**
 * An account shaped like one an agent fleet would actually produce.
 *
 * The shape matters more than the size: memories cluster into a few scopes,
 * key namespaces follow the `<bucket>-lessons::<slug>` convention, and labels
 * follow a long tail with a couple of common ones — which is what produces
 * legible clusters rather than either a hairball or a dust cloud.
 */
export function realisticAccount({
  count = 240,
  scopes = SCOPES.length,
  archivedShare = 0.08,
  recurringShare = 0.25,
  withHubLabel = false,
}: RealisticAccountOptions = {}): GraphMemoryInput[] {
  const next = sequence(0x10c0de);
  const scopeList = SCOPES.slice(0, Math.max(1, Math.min(scopes, SCOPES.length)));

  return Array.from({ length: count }, (_, i) => {
    const roll = next();
    // Weighted toward the first scopes, so cluster sizes differ — an account
    // with six equal clusters looks synthetic at a glance.
    const scope =
      scopeList[Math.floor(Math.sqrt(roll % (scopeList.length * scopeList.length)))] ?? scopeList[0];
    const bucket = BUCKETS[roll % BUCKETS.length] ?? BUCKETS[0];
    const topicA = TOPICS[roll % TOPICS.length] ?? TOPICS[0];
    const topicB = TOPICS[(roll >>> 8) % TOPICS.length] ?? TOPICS[0];

    const tags = [`loop::${bucket}`, topicA];
    if (topicB !== topicA && roll % 3 === 0) tags.push(topicB);
    if (withHubLabel) tags.push('source::end-of-run');

    const archived = (roll >>> 16) % 100 < archivedShare * 100;
    const recurring = (roll >>> 20) % 100 < recurringShare * 100;

    return {
      key: `${bucket}::${topicA}-${i}`,
      scope,
      tags,
      origin_repo: scope.startsWith('repo::') ? scope.slice('repo::'.length) : 'mthines/lorekit',
      updated_at: daysAgo((roll >>> 4) % 90),
      ...(archived ? { archived_at: daysAgo((roll >>> 6) % 30) } : {}),
      ...(recurring ? { seen_count: 1 + ((roll >>> 12) % 14) } : {}),
    };
  });
}

/** One memory. The degenerate layout: a single node beside its scope. */
export function singleMemory(): GraphMemoryInput[] {
  return [
    {
      key: 'aw-lessons::worktree-first',
      scope: 'repo::mthines/lorekit',
      tags: ['loop::aw-lessons', 'workflow'],
      updated_at: daysAgo(2),
      seen_count: 3,
    },
  ];
}

/**
 * Memories with nothing whatsoever in common — no shared label, no shared key
 * namespace, no shared repo.
 *
 * The "is it broken or is my lore just unrelated?" case. Every node hangs off
 * its scope by the skeleton alone and there is not one relationship line, which
 * is a legitimate picture the map has to render without looking empty.
 */
export function unrelatedMemories(count = 40): GraphMemoryInput[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `standalone-${i}`,
    scope: 'global',
    tags: [`unique-${i}`],
    updated_at: daysAgo(i % 60),
  }));
}

/**
 * Every memory carrying the same handful of labels.
 *
 * Hub suppression fires and removes them all, so the map draws a scope cluster
 * with no relationships — and the coverage notice has to explain why, because
 * "no relationships" and "your labels are on everything" look identical on
 * screen and mean opposite things.
 */
export function hubHeavyAccount(count = 120): GraphMemoryInput[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `aw-lessons::lesson-${i}`,
    scope: 'repo::mthines/lorekit',
    tags: ['loop::aw-lessons', 'source::end-of-run', 'status::active'],
    updated_at: daysAgo(i % 45),
  }));
}

/** One scope holding everything — the "I only ever write to global" account. */
export function oneGiantScope(count = 400): GraphMemoryInput[] {
  return realisticAccount({ count, scopes: 1 });
}

/**
 * Keys and scopes at the lengths that break a layout rather than a parser.
 *
 * The hover read-out and the legend both render untruncated strings; this is
 * the fixture that shows whether they clip, wrap or overflow their container.
 */
export function awkwardLabels(): GraphMemoryInput[] {
  return [
    {
      key: 'implement-suggestion-lessons::a-mechanism-clause-you-correct-in-the-pr-body-must-be-corrected-in-every-doc-that-copies-it',
      scope: 'branch::mthines/lorekit::feat/a-branch-name-nobody-would-choose-on-purpose',
      tags: ['loop::implement-suggestion-lessons', 'source::watch-reflag'],
      updated_at: daysAgo(1),
      seen_count: 12,
    },
    {
      key: 'lessons::日本語のキーと絵文字 🧠 と RTL نص',
      scope: 'global',
      tags: ['unicode', 'i18n'],
      updated_at: daysAgo(3),
    },
    {
      key: 'x',
      scope: 'global',
      tags: ['unicode'],
      updated_at: daysAgo(4),
    },
  ];
}

/**
 * Every memory archived.
 *
 * The whole graph renders dimmed, including the scope nodes — which is the
 * check that dimming preserved the scope hue rather than greying everything to
 * the same slate (`palette.dim`).
 */
export function archivedAccount(count = 80): GraphMemoryInput[] {
  return realisticAccount({ count, archivedShare: 1 });
}
