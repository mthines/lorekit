/**
 * Shared fixtures for the filter-surface stories.
 *
 * A separate module rather than a named export from `FilterMenu.stories.tsx`:
 * every export of a CSF file IS a story, so a fixture exported from there is
 * indexed, rendered, and screenshotted as one — which fails loudly the moment
 * it is not a component.
 */

import type { FacetValue, Filter } from '@/lib/filters';

/**
 * A realistic catalog: several values per dimension, counts that differ, and
 * values that overlap across dimensions (`main` the branch vs `mthines/lorekit`
 * the repo) so the cross-dimension type-ahead has something to disambiguate.
 */
export const FACETS: FacetValue[] = [
  { facet: 'tag', value: 'performance', count: 24 },
  { facet: 'tag', value: 'auth', count: 18 },
  { facet: 'tag', value: 'ci/flaky', count: 12 },
  { facet: 'tag', value: 'testing', count: 7 },
  { facet: 'source_agent', value: 'claude', count: 41 },
  { facet: 'source_agent', value: 'aw', count: 16 },
  { facet: 'trigger', value: 'tool-failure', count: 22 },
  { facet: 'trigger', value: 'retrospective', count: 11 },
  { facet: 'trigger', value: 'review-comment', count: 5 },
  { facet: 'origin_repo', value: 'mthines/lorekit', count: 38 },
  { facet: 'origin_repo', value: 'mthines/agent-skills', count: 9 },
  { facet: 'origin_branch', value: 'main', count: 27 },
  { facet: 'origin_branch', value: 'feat/explorer-filters', count: 6 },
  { facet: 'origin_branch', value: 'feat/maintenance', count: 3 },
  { facet: 'origin_pr', value: '311', count: 8 },
  { facet: 'origin_pr', value: '482', count: 4 },
];

/** A filled bar exercising all three pill shapes: set-valued, negated, single. */
export const APPLIED_FILTERS: Filter[] = [
  { field: 'label', operator: 'all', values: ['performance', 'auth'] },
  { field: 'branch', operator: 'nin', values: ['main'] },
  { field: 'pr', operator: 'in', values: ['311'] },
];
