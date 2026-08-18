/**
 * The synthetic plan-ceiling account, in ONE place.
 *
 * `build.spec.ts` asserts the builder's bounds against it and
 * `scripts/bench-lore-graph.mjs` times the builder against it, and those two
 * only mean anything together: the spec's work bound is calibrated from numbers
 * the benchmark measured. Two copies kept in step by a prose comment is what
 * this used to be, and its shape was wrong twice in a row — first with both
 * non-label kinds over `hubSize`, then with the two label families colliding
 * under one `t*` prefix. A shape that must be exactly one thing should be
 * written exactly once.
 *
 * It lives beside the module it exercises rather than under a test directory so
 * the plain `node` benchmark can import it through the same `@/`-alias resolver
 * hook it already uses for `build.ts`. It is a pure data factory with no runtime
 * imports, so nothing pulls it into a page bundle.
 */

import type { GraphMemoryInput } from './build';

/** The free-plan active-memory cap (`docs/limits.md`) — the real worst case. */
export const PLAN_CEILING_MEMORIES = 5_000;

/**
 * Build a synthetic account shaped like a real one, straddling `hubSize: 64`.
 *
 * Shaped, not uniformly random: a uniform-random dataset shares almost no terms
 * and would measure the cheap path. Every family's size is chosen so that both
 * the hub-suppression bound AND the path it protects are exercised — a fixture
 * whose families all land on ONE side of the cutoff only measures half the
 * algorithm.
 *
 * | Family         | Terms | Members each | Side of `hubSize: 64` |
 * | -------------- | ----- | ------------ | --------------------- |
 * | `topic-*`      |   300 |          ~17 | under — the long tail |
 * | `theme-*`      |    97 |          ~52 | under, but only just: the longest posting list the label path must walk |
 * | `facet-*`      |     3 |        ~1667 | **over** — suppression fires |
 * | `bucket-*::`   |   100 |           50 | under (key namespaces) |
 * | `owner/repo-*` |   100 |           50 | under (origin repos) |
 *
 * Changing any modulus below changes both the benchmark's published figure and
 * the spec's work bound — re-measure and update `docs/lore-graph.md` with them.
 */
export function planCeilingMemories(count: number = PLAN_CEILING_MEMORIES): GraphMemoryInput[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `bucket-${i % 100}::lesson-${i}`,
    scope: `repo::owner/repo-${i % 100}`,
    tags: [`topic-${i % 300}`, `theme-${i % 97}`, `facet-${i % 3}`],
    origin_repo: `owner/repo-${i % 100}`,
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 3600)).toISOString(),
  }));
}
