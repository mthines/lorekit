import { describe, it, expect } from 'vitest';
import type { UsageStatRow, UsageSummary } from '@lorekit/schemas/usage';
import {
  bucketScopeType,
  failuresByToolOutcome,
  meanLatencyByToolScope,
  coverageGapsByScopeType,
  readsByClient,
  readsByAgentFamily,
  summarizeHealth,
} from './usage-health';

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    total_events: 0,
    reads: 0,
    writes: 0,
    other: 0,
    records_read: 0,
    archived: 0,
    expired: 0,
    by_outcome: {},
    ...overrides,
  };
}

function row(overrides: Partial<UsageStatRow> = {}): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'global',
    event_count: 1,
    record_count: 1,
    total_duration_ms: 100,
    ...overrides,
  };
}

describe('bucketScopeType', () => {
  it('passes the closed vocabulary through unchanged', () => {
    for (const t of ['global', 'project', 'repo', 'branch', 'mixed', 'invalid']) {
      expect(bucketScopeType(t)).toBe(t);
    }
  });

  it('buckets legacy free-text values into "other"', () => {
    expect(bucketScopeType('dash0')).toBe('other');
    expect(bucketScopeType('daily-report')).toBe('other');
    expect(bucketScopeType('bogusprefix')).toBe('other');
  });

  it('buckets null (no scope at all — org.*/member.* tools) into "other"', () => {
    expect(bucketScopeType(null)).toBe('other');
  });
});

describe('failuresByToolOutcome', () => {
  it('excludes ok rows', () => {
    expect(failuresByToolOutcome([row({ outcome: 'ok' })])).toEqual([]);
  });

  it('sums identical repeated failures into one row rather than listing each attempt', () => {
    const rows = [
      row({ tool_name: 'org.create', outcome: 'error', event_count: 100, client: 'cli', scope_type: null }),
      row({ tool_name: 'org.create', outcome: 'error', event_count: 55, client: 'cli', scope_type: null }),
    ];
    expect(failuresByToolOutcome(rows)).toEqual([
      {
        tool_name: 'org.create',
        outcome: 'error',
        event_count: 155,
        topContext: { client: 'cli', scope_type: 'other', event_count: 155 },
      },
    ]);
  });

  it('ranks the most frequent failure first', () => {
    const rows = [
      row({ tool_name: 'memory.write', outcome: 'cap_exceeded', event_count: 3 }),
      row({ tool_name: 'org.create', outcome: 'error', event_count: 155 }),
      row({ tool_name: 'memory.list', outcome: 'rate_limited', event_count: 20 }),
    ];
    expect(failuresByToolOutcome(rows).map((r) => r.tool_name)).toEqual(['org.create', 'memory.list', 'memory.write']);
  });

  it('picks the (client, scope_type) pairing with the most events as topContext', () => {
    const rows = [
      row({ tool_name: 'memory.read', outcome: 'error', event_count: 150, client: 'cli', scope_type: 'branch' }),
      row({ tool_name: 'memory.read', outcome: 'error', event_count: 37, client: 'mcp', scope_type: 'repo' }),
    ];
    const [result] = failuresByToolOutcome(rows);
    expect(result.event_count).toBe(187);
    expect(result.topContext).toEqual({ client: 'cli', scope_type: 'branch', event_count: 150 });
  });

  it('buckets a null client as its own context, distinct from a named one', () => {
    const rows = [
      row({ tool_name: 'memory.list', outcome: 'error', event_count: 10, client: null, scope_type: 'global' }),
    ];
    expect(failuresByToolOutcome(rows)[0].topContext).toEqual({ client: null, scope_type: 'global', event_count: 10 });
  });
});

describe('meanLatencyByToolScope', () => {
  it('computes total_duration_ms / event_count per (tool_name, scope_type)', () => {
    const rows = [
      row({ tool_name: 'memory.search', scope_type: 'global', event_count: 10, total_duration_ms: 3860 }),
    ];
    expect(meanLatencyByToolScope(rows)).toEqual([
      { tool_name: 'memory.search', scope_type: 'global', event_count: 10, meanMs: 386 },
    ]);
  });

  it('sums across outcomes for the same (tool_name, scope_type)', () => {
    const rows = [
      row({ tool_name: 'memory.list', scope_type: 'global', outcome: 'ok', event_count: 8, total_duration_ms: 2000 }),
      row({ tool_name: 'memory.list', scope_type: 'global', outcome: 'error', event_count: 2, total_duration_ms: 200 }),
    ];
    expect(meanLatencyByToolScope(rows)).toEqual([
      { tool_name: 'memory.list', scope_type: 'global', event_count: 10, meanMs: 220 },
    ]);
  });

  it('excludes rows with a null duration rather than treating it as zero', () => {
    const rows = [
      row({ tool_name: 'memory.read', scope_type: 'repo', event_count: 5, total_duration_ms: null }),
    ];
    expect(meanLatencyByToolScope(rows)).toEqual([]);
  });

  it('buckets legacy scope_type values before grouping', () => {
    const rows = [
      row({ tool_name: 'memory.search', scope_type: 'dash0', event_count: 4, total_duration_ms: 400 }),
    ];
    expect(meanLatencyByToolScope(rows)).toEqual([
      { tool_name: 'memory.search', scope_type: 'other', event_count: 4, meanMs: 100 },
    ]);
  });

  it('ranks the slowest first', () => {
    const rows = [
      row({ tool_name: 'a', scope_type: 'global', event_count: 1, total_duration_ms: 100 }),
      row({ tool_name: 'b', scope_type: 'global', event_count: 1, total_duration_ms: 500 }),
    ];
    expect(meanLatencyByToolScope(rows).map((r) => r.tool_name)).toEqual(['b', 'a']);
  });
});

describe('coverageGapsByScopeType', () => {
  it('reproduces the documented branch-scope coverage gap', () => {
    const rows = [row({ tool_name: 'memory.list', scope_type: 'branch', event_count: 1176, record_count: 15 })];
    const [result] = coverageGapsByScopeType(rows);
    expect(result.event_count).toBe(1176);
    expect(result.record_count).toBe(15);
    expect(result.recordsPerCall).toBeCloseTo(15 / 1176, 5);
  });

  it('sums event_count and record_count across tools for the same scope_type', () => {
    const rows = [
      row({ tool_name: 'memory.list', scope_type: 'project', event_count: 2000, record_count: 900 }),
      row({ tool_name: 'memory.search', scope_type: 'project', event_count: 746, record_count: 230 }),
    ];
    const [result] = coverageGapsByScopeType(rows);
    expect(result.event_count).toBe(2746);
    expect(result.record_count).toBe(1130);
  });

  it('ranks the worst coverage gap first (lowest records per call)', () => {
    const rows = [
      row({ scope_type: 'global', event_count: 100, record_count: 3310 }),
      row({ tool_name: 'memory.list', scope_type: 'branch', event_count: 1176, record_count: 15 }),
    ];
    expect(coverageGapsByScopeType(rows).map((r) => r.scope_type)).toEqual(['branch', 'global']);
  });

  it('reports zero rather than NaN/Infinity for a scope_type with no calls', () => {
    // Not reachable via real usage rows (a row implies at least one call), but
    // the guard exists so a future caller cannot divide by zero silently.
    const rows = [row({ scope_type: 'repo', event_count: 0, record_count: 0 })];
    expect(coverageGapsByScopeType(rows)[0]?.recordsPerCall).toBe(0);
  });

  it('buckets legacy and null scope_type values into "other" rather than their own row', () => {
    const rows = [
      row({ scope_type: 'bogusprefix', event_count: 5, record_count: 2 }),
      row({ scope_type: null, event_count: 3, record_count: 0 }),
    ];
    const result = coverageGapsByScopeType(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ scope_type: 'other', event_count: 8, record_count: 2 });
  });
});

describe('summarizeHealth', () => {
  it('computes success rate from by_outcome, not by re-summing failures', () => {
    const result = summarizeHealth(summary({ total_events: 200, by_outcome: { ok: 187, error: 13 } }), []);
    expect(result.totalCalls).toBe(200);
    expect(result.successRate).toBeCloseTo(0.935, 5);
  });

  it('reports a 100% success rate for an empty window, not NaN', () => {
    const result = summarizeHealth(summary({ total_events: 0, by_outcome: {} }), []);
    expect(result.successRate).toBe(1);
  });

  it('surfaces the most frequent failure as topFailure', () => {
    const rows = [
      row({ tool_name: 'org.create', outcome: 'error', event_count: 155 }),
      row({ tool_name: 'memory.list', outcome: 'rate_limited', event_count: 20 }),
    ];
    const failures = failuresByToolOutcome(rows);
    const result = summarizeHealth(summary({ total_events: 500, by_outcome: { ok: 325, error: 175 } }), failures);
    expect(result.topFailure?.tool_name).toBe('org.create');
  });

  it('reports topFailure as null when nothing failed', () => {
    const result = summarizeHealth(summary({ total_events: 40, by_outcome: { ok: 40 } }), []);
    expect(result.topFailure).toBeNull();
  });
});

describe('readsByClient', () => {
  it('sums event_count and record_count per client', () => {
    const rows = [
      row({ client: 'mcp', event_count: 100, record_count: 3100 }),
      row({ client: 'mcp', event_count: 20, record_count: 600 }),
      row({ client: 'cli', event_count: 5, record_count: 5 }),
    ];
    const result = readsByClient(rows);
    expect(result).toContainEqual({ client: 'mcp', event_count: 120, record_count: 3700 });
    expect(result).toContainEqual({ client: 'cli', event_count: 5, record_count: 5 });
  });

  it('keeps a null client as its own row (unattributed, e.g. pre-B1 rows)', () => {
    const rows = [row({ client: null, event_count: 10, record_count: 10 })];
    expect(readsByClient(rows)).toEqual([{ client: null, event_count: 10, record_count: 10 }]);
  });

  it('ranks by event_count desc', () => {
    const rows = [
      row({ client: 'cli', event_count: 5, record_count: 5 }),
      row({ client: 'mcp', event_count: 500, record_count: 500 }),
    ];
    expect(readsByClient(rows).map((r) => r.client)).toEqual(['mcp', 'cli']);
  });
});

describe('readsByAgentFamily', () => {
  it('groups by (kind, host)', () => {
    const rows = [
      row({ kind: 'lesson', host: 'reviewer', event_count: 10, record_count: 300 }),
      row({ kind: 'lesson', host: 'reviewer', event_count: 5, record_count: 150 }),
      row({ kind: 'bus', host: 'aw', event_count: 2, record_count: 2 }),
    ];
    const result = readsByAgentFamily(rows);
    expect(result).toContainEqual({ kind: 'lesson', host: 'reviewer', event_count: 15, record_count: 450 });
    expect(result).toContainEqual({ kind: 'bus', host: 'aw', event_count: 2, record_count: 2 });
  });

  it('excludes rows with neither kind nor host — nothing to attribute', () => {
    const rows = [row({ kind: null, host: null, event_count: 10, record_count: 10 })];
    expect(readsByAgentFamily(rows)).toEqual([]);
  });

  it('keeps a partial pair (kind known, host unknown) as its own row', () => {
    const rows = [row({ kind: 'signal', host: null, event_count: 3, record_count: 3 })];
    expect(readsByAgentFamily(rows)).toEqual([{ kind: 'signal', host: null, event_count: 3, record_count: 3 }]);
  });

  it('ranks by event_count desc', () => {
    const rows = [
      row({ kind: 'signal', host: 'reviewer', event_count: 1, record_count: 1 }),
      row({ kind: 'lesson', host: 'aw', event_count: 100, record_count: 100 }),
    ];
    expect(readsByAgentFamily(rows).map((r) => r.kind)).toEqual(['lesson', 'signal']);
  });
});
