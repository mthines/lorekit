import { describe, it, expect } from 'vitest';
import {
  ListFacetsQuerySchema,
  ActivityQuerySchema,
  MemoryDimensionFilterSchema,
} from '@lorekit/schemas/memory';
import {
  hasMemoryFilters,
  memoryFilterRpcArgs,
  type MemoryFilterRpcArgs,
} from './memory-filter-args.js';

const NONE = memoryFilterRpcArgs({});

describe('memoryFilterRpcArgs — the unfiltered baseline', () => {
  it('maps an empty param set to all-NULL filters with default modes', () => {
    // Every RPC reads NULL as "this dimension is untouched", so this is the
    // object that must leave a pre-filter caller's result byte-for-byte
    // unchanged.
    expect(NONE).toEqual({
      p_scope: null,
      p_tags: null,
      p_tags_mode: 'any',
      p_source_agent: null,
      p_source_agent_mode: 'in',
      p_trigger: null,
      p_trigger_mode: 'in',
      p_kind: null,
      p_kind_mode: 'in',
      p_host: null,
      p_host_mode: 'in',
      p_origin_repo: null,
      p_origin_repo_mode: 'in',
      p_origin_branch: null,
      p_origin_branch_mode: 'in',
      p_origin_pr: null,
      p_origin_pr_mode: 'in',
    });
  });

  it('defaults tags to `any` and every scalar to `in`, matching the schema', () => {
    // Defaulted in two places on purpose — a caller building params by hand
    // must not be able to produce an object the RPC reads differently from the
    // route. Assert against the SCHEMA's defaults so they cannot drift apart.
    const parsed = MemoryDimensionFilterSchema.parse({});
    expect(NONE.p_tags_mode).toBe(parsed.tags_mode);
    expect(NONE.p_kind_mode).toBe(parsed.kind_mode);
    expect(NONE.p_origin_pr_mode).toBe(parsed.origin_pr_mode);
  });
});

describe('memoryFilterRpcArgs — value lists', () => {
  it('splits a comma list and trims each value', () => {
    expect(memoryFilterRpcArgs({ kind: 'lesson, signal' }).p_kind).toEqual(['lesson', 'signal']);
  });

  it('maps a present-but-empty param to NULL, not to an empty array', () => {
    // `?kind=` from a hand-edited URL must apply NO filter. An empty array is a
    // filter matching nothing, which would blank the page instead.
    for (const raw of ['', ' ', ',', ' , , ']) {
      expect(memoryFilterRpcArgs({ kind: raw }).p_kind, JSON.stringify(raw)).toBeNull();
    }
  });

  it('carries the mode through per dimension', () => {
    const args = memoryFilterRpcArgs({
      kind: 'bus',
      kind_mode: 'nin',
      tags: 'perf',
      tags_mode: 'none',
    });
    expect(args.p_kind_mode).toBe('nin');
    expect(args.p_tags_mode).toBe('none');
    // Untouched dimensions keep their defaults rather than inheriting a mode.
    expect(args.p_host_mode).toBe('in');
  });

  it('maps every dimension the filter bar can produce', () => {
    const args = memoryFilterRpcArgs({
      scope: 'repo::a/b',
      tags: 'perf',
      source_agent: 'aw',
      trigger: 'stuck-loop',
      kind: 'lesson',
      host: 'reviewer',
      origin_repo: 'mthines/lorekit',
      origin_branch: 'main',
      origin_pr: '311',
    });
    // Anti-vacuity: nine dimensions in, nine non-null out. A dimension silently
    // dropped by the mapper is a filter that does nothing.
    const set = Object.entries(args).filter(([k, v]) => !k.endsWith('_mode') && v !== null);
    expect(set).toHaveLength(9);
  });
});

describe('memoryFilterRpcArgs — origin_pr is an integer column', () => {
  it('keeps digits-only entries', () => {
    expect(memoryFilterRpcArgs({ origin_pr: '311,482' }).p_origin_pr).toEqual(['311', '482']);
  });

  it('DROPS a non-numeric entry rather than breaking the page', () => {
    // The documented list-route behaviour: the list arrives from a hand-editable
    // URL and one bad entry should narrow the filter, not 400 the request.
    expect(memoryFilterRpcArgs({ origin_pr: '311,oops' }).p_origin_pr).toEqual(['311']);
  });

  it('applies NO filter when every entry is non-numeric', () => {
    // Not an empty array: that would match nothing, so a typo would silently
    // empty the chart instead of leaving it unfiltered.
    expect(memoryFilterRpcArgs({ origin_pr: 'oops,nope' }).p_origin_pr).toBeNull();
  });

  it('rejects the shapes that look numeric but are not', () => {
    expect(memoryFilterRpcArgs({ origin_pr: '3.11,-4,1e3,+7' }).p_origin_pr).toBeNull();
  });
});

describe('hasMemoryFilters', () => {
  it('is false for the unfiltered baseline', () => {
    expect(hasMemoryFilters(NONE)).toBe(false);
  });

  it('is true as soon as any single dimension is applied', () => {
    // Exhaustive over the nine, so a dimension added to the args type without
    // being added here cannot silently make a filtered view report "unfiltered".
    const dims: Array<keyof MemoryFilterRpcArgs> = [
      'p_scope',
      'p_tags',
      'p_source_agent',
      'p_trigger',
      'p_kind',
      'p_host',
      'p_origin_repo',
      'p_origin_branch',
      'p_origin_pr',
    ];
    for (const dim of dims) {
      const value = dim === 'p_scope' ? 'global' : ['x'];
      expect(hasMemoryFilters({ ...NONE, [dim]: value } as MemoryFilterRpcArgs), dim).toBe(true);
    }
  });

  it('ignores the modes — a mode alone narrows nothing', () => {
    expect(hasMemoryFilters({ ...NONE, p_kind_mode: 'nin' })).toBe(false);
  });
});

/**
 * The mapper takes what the ROUTES validate, so its input type has to stay a
 * superset of what they emit. These assert against the real schemas rather than
 * a hand-written sample, so a param renamed on a route fails here.
 */
describe('agreement with the route schemas', () => {
  it('accepts everything ListFacetsQuerySchema parses', () => {
    const parsed = ListFacetsQuerySchema.parse({ kind: 'lesson', tags: 'perf', origin_pr: '311' });
    const args = memoryFilterRpcArgs(parsed);
    expect(args.p_kind).toEqual(['lesson']);
    expect(args.p_tags).toEqual(['perf']);
    expect(args.p_origin_pr).toEqual(['311']);
  });

  it('accepts everything ActivityQuerySchema parses', () => {
    // The route this migration adds the filters to. If ActivityQuerySchema ever
    // stops carrying the dimension shape, this stops compiling.
    const parsed = ActivityQuerySchema.parse({ bucket: 'hour', host: 'reviewer' });
    expect(memoryFilterRpcArgs(parsed).p_host).toEqual(['reviewer']);
  });

  it('produces the same args from the same filters on both routes', () => {
    // The property that makes the chart and the catalog agree: one filter state
    // must reach both RPCs identically.
    const raw = { scope: 'repo::a/b', kind: 'lesson,bus', kind_mode: 'nin', origin_pr: '7' };
    expect(memoryFilterRpcArgs(ListFacetsQuerySchema.parse(raw))).toEqual(
      memoryFilterRpcArgs(ActivityQuerySchema.parse(raw)),
    );
  });
});
