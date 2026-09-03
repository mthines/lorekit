import { describe, it, expect } from 'vitest';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import {
  bucketScopeType,
  excludeDashboardReads,
  failuresByToolOutcome,
  meanLatencyByToolScope,
  coverageGapsByScopeType,
  readsByClient,
  readsByAgentFamily,
  summarizeHealth,
  healthTrend,
  readCoverage,
  healthVerdict,
} from './usage-health';

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
  it('computes success rate by summing rows, not a pre-rolled summary', () => {
    const rows = [row({ outcome: 'ok', event_count: 187 }), row({ outcome: 'error', event_count: 13 })];
    const result = summarizeHealth(rows, []);
    expect(result.totalCalls).toBe(200);
    expect(result.successRate).toBeCloseTo(0.935, 5);
  });

  it('reports a 100% success rate for an empty window, not NaN', () => {
    const result = summarizeHealth([], []);
    expect(result.successRate).toBe(1);
  });

  it('surfaces the most frequent failure as topFailure', () => {
    const rows = [
      row({ tool_name: 'org.create', outcome: 'error', event_count: 155 }),
      row({ tool_name: 'memory.list', outcome: 'rate_limited', event_count: 20 }),
    ];
    const failures = failuresByToolOutcome(rows);
    const result = summarizeHealth(rows, failures);
    expect(result.topFailure?.tool_name).toBe('org.create');
  });

  it('reports topFailure as null when nothing failed', () => {
    const result = summarizeHealth([row({ outcome: 'ok', event_count: 40 })], []);
    expect(result.topFailure).toBeNull();
  });

  it('carries the read coverage alongside the reliability figures', () => {
    const rows = [row({ tool_name: 'memory.search', event_count: 10, record_count: 5 })];
    expect(summarizeHealth(rows, []).coverage).toEqual({
      readCalls: 10,
      recordsFound: 5,
      recordsPerCall: 0.5,
    });
  });
});

describe('readCoverage', () => {
  it('divides records found by the reads that asked for them', () => {
    const rows = [
      row({ tool_name: 'memory.list', event_count: 100, record_count: 40 }),
      row({ tool_name: 'memory.search', event_count: 100, record_count: 60 }),
    ];
    expect(readCoverage(rows)).toEqual({ readCalls: 200, recordsFound: 100, recordsPerCall: 0.5 });
  });

  it('ignores tools that carry no records by construction', () => {
    // A write-heavy window must not read as a coverage failure: `memory.write`
    // and `org.*` always report `record_count: 0`.
    const rows = [
      row({ tool_name: 'memory.write', event_count: 500, record_count: 0 }),
      row({ tool_name: 'org.create', event_count: 5, record_count: 0 }),
      row({ tool_name: 'memory.read', event_count: 10, record_count: 20 }),
    ];
    expect(readCoverage(rows)).toEqual({ readCalls: 10, recordsFound: 20, recordsPerCall: 2 });
  });

  it('returns null rather than 0/0 when the window has no reads at all', () => {
    expect(readCoverage([row({ tool_name: 'memory.write', event_count: 500, record_count: 0 })])).toBeNull();
    expect(readCoverage([])).toBeNull();
  });
});

describe('healthVerdict', () => {
  it('reports reliability when it is the worse of the two dimensions', () => {
    expect(healthVerdict({ successRate: 0.8, coverage: { readCalls: 10, recordsFound: 30, recordsPerCall: 3 } })).toEqual({
      verdict: 'unhealthy',
      driver: 'reliability',
    });
  });

  it('reports coverage when perfectly reliable calls are finding nothing', () => {
    // The whole reason the verdict is two-dimensional: no `outcome` value means
    // "found nothing", so this window is 100% `ok` and still the thing a reader
    // came to the page to discover.
    expect(healthVerdict({ successRate: 1, coverage: { readCalls: 1176, recordsFound: 15, recordsPerCall: 15 / 1176 } })).toEqual({
      verdict: 'unhealthy',
      driver: 'coverage',
    });
  });

  it('grades thin-but-present coverage as degraded, not unhealthy', () => {
    expect(healthVerdict({ successRate: 1, coverage: { readCalls: 100, recordsFound: 60, recordsPerCall: 0.6 } })).toEqual({
      verdict: 'degraded',
      driver: 'coverage',
    });
  });

  it('falls back to reliability alone when there is no coverage to weigh', () => {
    expect(healthVerdict({ successRate: 1, coverage: null })).toEqual({
      verdict: 'healthy',
      driver: 'reliability',
    });
  });

  it('breaks a tie toward reliability', () => {
    expect(healthVerdict({ successRate: 1, coverage: { readCalls: 10, recordsFound: 10, recordsPerCall: 1 } })).toEqual({
      verdict: 'healthy',
      driver: 'reliability',
    });
  });
});

describe('excludeDashboardReads', () => {
  it('drops rows whose client is dashboard', () => {
    const rows = [row({ client: 'dashboard', event_count: 10 }), row({ client: 'cli', event_count: 5 })];
    expect(excludeDashboardReads(rows)).toEqual([row({ client: 'cli', event_count: 5 })]);
  });

  it('keeps rows with a non-dashboard or null client', () => {
    const rows = [row({ client: 'mcp' }), row({ client: null })];
    expect(excludeDashboardReads(rows)).toEqual(rows);
  });
});

describe('healthTrend', () => {
  it('returns null when the previous window had no calls', () => {
    const current = [row({ outcome: 'ok', event_count: 50 })];
    expect(healthTrend(current, [])).toBeNull();
  });

  it('returns null when the previous window is too small to compare against', () => {
    // One prior call vs. a thousand renders "+99,900%" — arithmetically correct
    // and pure noise. MIN_TREND_CALLS is 20.
    const current = [row({ outcome: 'ok', event_count: 1000 })];
    expect(healthTrend(current, [row({ outcome: 'ok', event_count: 1 })])).toBeNull();
    expect(healthTrend(current, [row({ outcome: 'ok', event_count: 19 })])).toBeNull();
    expect(healthTrend(current, [row({ outcome: 'ok', event_count: 20 })])).not.toBeNull();
  });

  it('computes call-volume % change and a percentage-point success-rate delta', () => {
    const previous = [row({ outcome: 'ok', event_count: 90 }), row({ outcome: 'error', event_count: 10 })];
    const current = [row({ outcome: 'ok', event_count: 190 }), row({ outcome: 'error', event_count: 10 })];
    const result = healthTrend(current, previous);
    expect(result?.totalCallsChangePct).toBeCloseTo(100, 5);
    // previous success rate 0.9, current 0.95 -> +5.0pp
    expect(result?.successRateDeltaPct).toBeCloseTo(5, 5);
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
