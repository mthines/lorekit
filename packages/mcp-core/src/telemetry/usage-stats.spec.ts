import { describe, it, expect } from 'vitest';
import {
  parseUsageWindow,
  usageToolKind,
  summarizeUsageRows,
  rollupByScopeType,
  countRecords,
  parseResultCountHeader,
  parseCorrelationId,
  UsageStatsError,
  USAGE_PERIODS,
  EXPIRED_TOOL_NAME,
  type UsageStatRow,
} from './usage-stats.js';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

describe('parseUsageWindow', () => {
  it('returns an all-time window when nothing is supplied', () => {
    expect(parseUsageWindow({}, NOW)).toEqual({ since: null, until: null });
  });

  it('resolves each rolling period back from now', () => {
    expect(parseUsageWindow({ period: '24h' }, NOW).since).toBe('2026-07-30T12:00:00.000Z');
    expect(parseUsageWindow({ period: '7d' }, NOW).since).toBe('2026-07-24T12:00:00.000Z');
    expect(parseUsageWindow({ period: '30d' }, NOW).since).toBe('2026-07-01T12:00:00.000Z');
    expect(parseUsageWindow({ period: 'all' }, NOW).since).toBeNull();
  });

  it('lets an explicit since override the period, and keeps until open-ended', () => {
    const w = parseUsageWindow({ period: '7d', since: '2026-07-30T00:00:00.000Z' }, NOW);
    expect(w).toEqual({ since: '2026-07-30T00:00:00.000Z', until: null });
  });

  it('accepts an explicit half-open [since, until)', () => {
    const w = parseUsageWindow({ since: '2026-07-01T00:00:00Z', until: '2026-07-31T00:00:00Z' }, NOW);
    expect(w.since).toBe('2026-07-01T00:00:00.000Z');
    expect(w.until).toBe('2026-07-31T00:00:00.000Z');
  });

  it('treats empty-string params as absent', () => {
    expect(parseUsageWindow({ since: '', until: '' }, NOW)).toEqual({ since: null, until: null });
  });

  it('rejects an unknown period', () => {
    expect(() => parseUsageWindow({ period: '1y' }, NOW)).toThrow(UsageStatsError);
  });

  it('rejects an unparseable date', () => {
    expect(() => parseUsageWindow({ since: 'not-a-date' }, NOW)).toThrow(UsageStatsError);
  });

  it('rejects an inverted window (until <= since)', () => {
    expect(() => parseUsageWindow({ since: '2026-07-31T00:00:00Z', until: '2026-07-01T00:00:00Z' }, NOW))
      .toThrow(/until must be strictly after since/);
    expect(() => parseUsageWindow({ since: '2026-07-01T00:00:00Z', until: '2026-07-01T00:00:00Z' }, NOW))
      .toThrow(UsageStatsError);
  });

  it('allows a future since (empty result, not an error)', () => {
    expect(() => parseUsageWindow({ since: '2099-01-01T00:00:00Z' }, NOW)).not.toThrow();
  });
});

describe('usageToolKind', () => {
  it('classifies read tools', () => {
    for (const t of ['memory.read', 'memory.list', 'memory.search', 'memory.scopes', 'memory.usage', 'org.list', 'member.list']) {
      expect(usageToolKind(t), t).toBe('read');
    }
  });
  it('classifies write tools', () => {
    for (const t of ['memory.write', 'memory.delete', 'memory.archive', 'memory.purge_expired', 'org.create', 'member.remove']) {
      expect(usageToolKind(t), t).toBe('write');
    }
  });
  it('falls back to other for an unknown tool', () => {
    expect(usageToolKind('memories.put.unmapped')).toBe('other');
  });
});

const ROWS: UsageStatRow[] = [
  { tool_name: 'memory.list', outcome: 'ok', scope_type: 'repo', event_count: 600, record_count: 6000, total_duration_ms: 42000 },
  { tool_name: 'memory.write', outcome: 'ok', scope_type: 'repo', event_count: 100, record_count: 0, total_duration_ms: 5000 },
  { tool_name: 'memory.write', outcome: 'cap_exceeded', scope_type: 'repo', event_count: 2, record_count: 0, total_duration_ms: 40 },
  { tool_name: 'memory.read', outcome: 'error', scope_type: null, event_count: 8, record_count: 0, total_duration_ms: 90 },
  // record_count 0 on purpose: historical archive rows predate the DELETE
  // handler setting the result-count header, so `archived` MUST come from
  // event_count, not record_count, or the window under-reports them.
  { tool_name: 'memory.archive', outcome: 'ok', scope_type: 'repo', event_count: 3, record_count: 0, total_duration_ms: 120 },
  { tool_name: 'memory.expired', outcome: 'ok', scope_type: null, event_count: 1, record_count: 6, total_duration_ms: null },
];

describe('summarizeUsageRows', () => {
  it('separates CALL counts (reads/writes) from RECORD counts (records_read/archived/expired)', () => {
    expect(summarizeUsageRows(ROWS)).toEqual({
      total_events: 714,
      reads: 608,
      writes: 105,          // memory.write ×102 + memory.archive ×3
      other: 1,             // the memory.expired event
      records_read: 6000,   // "read 6000 memories" — not 608 read calls
      archived: 3,          // "3 lessons archived" — from event_count (record_count is 0)
      expired: 6,           // "6 lessons got expired"
      by_outcome: { ok: 704, cap_exceeded: 2, error: 8 },
    });
  });

  it('counts refused archives as CALLS but never as archives', () => {
    const refused: UsageStatRow[] = [
      { tool_name: 'memory.archive', outcome: 'ok', scope_type: 'repo', event_count: 3, record_count: 1, total_duration_ms: 120 },
      { tool_name: 'memory.archive', outcome: 'permission_denied', scope_type: 'repo', event_count: 4, record_count: 0, total_duration_ms: 20 },
      { tool_name: 'memory.archive', outcome: 'error', scope_type: 'repo', event_count: 5, record_count: 0, total_duration_ms: 30 },
    ];
    const summary = summarizeUsageRows(refused);
    // Every attempt is still a write CALL — the refusals are real traffic.
    expect(summary.writes).toBe(12);
    // Only the successful ones retired a memory.
    expect(summary.archived).toBe(3);
  });

  it('does not credit a failed read with the records it never returned', () => {
    const summary = summarizeUsageRows([
      { tool_name: 'memory.list', outcome: 'ok', scope_type: 'repo', event_count: 1, record_count: 10, total_duration_ms: 5 },
      { tool_name: 'memory.list', outcome: 'error', scope_type: 'repo', event_count: 1, record_count: 99, total_duration_ms: 5 },
    ]);
    expect(summary.reads).toBe(2);
    expect(summary.records_read).toBe(10);
  });

  it('is empty-safe', () => {
    expect(summarizeUsageRows([])).toEqual({
      total_events: 0, reads: 0, writes: 0, other: 0,
      records_read: 0, archived: 0, expired: 0, by_outcome: {},
    });
  });
});

describe('rollupByScopeType', () => {
  it('sums by scope_type, sorted by count desc', () => {
    expect(rollupByScopeType(ROWS)).toEqual([
      { scope_type: 'repo', event_count: 705 }, // list 600 + write 100 + write 2 + archive 3
      { scope_type: null, event_count: 9 },
    ]);
  });
});

describe('countRecords', () => {
  it('counts arrays and known collection shapes', () => {
    expect(countRecords([1, 2, 3])).toBe(3);
    expect(countRecords({ entries: [1, 2] })).toBe(2);
    expect(countRecords({ archived: [1] })).toBe(1);
    expect(countRecords({ results: [] })).toBe(0);
  });
  it('counts a single record object as 1 and a miss as 0', () => {
    expect(countRecords({ id: 'x', value: 'v' })).toBe(1);
    expect(countRecords(null)).toBe(0);
    expect(countRecords(undefined)).toBe(0);
  });
  it('returns null when it cannot tell (fail-safe)', () => {
    expect(countRecords('str')).toBeNull();
    expect(countRecords(5)).toBeNull();
  });
});

describe('parseResultCountHeader', () => {
  it('accepts non-negative integers', () => {
    expect(parseResultCountHeader('5')).toBe(5);
    expect(parseResultCountHeader('0')).toBe(0);
  });
  it('is fail-safe to null on anything else', () => {
    for (const bad of [null, undefined, '', 'abc', '-1', '2.5']) {
      expect(parseResultCountHeader(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe('parseCorrelationId', () => {
  it('accepts bounded PR/session/branch identifiers, trimmed', () => {
    expect(parseCorrelationId('mthines/lorekit#123')).toBe('mthines/lorekit#123');
    expect(parseCorrelationId('session_019Xyz')).toBe('session_019Xyz');
    expect(parseCorrelationId('  pr-42  ')).toBe('pr-42');
    expect(parseCorrelationId('feat/usage-stats:1')).toBe('feat/usage-stats:1');
  });
  it('rejects empty, over-long, and out-of-charset values', () => {
    expect(parseCorrelationId('')).toBeNull();
    expect(parseCorrelationId('   ')).toBeNull();
    expect(parseCorrelationId(null)).toBeNull();
    expect(parseCorrelationId('a'.repeat(201))).toBeNull();
    expect(parseCorrelationId('has spaces')).toBeNull();
    expect(parseCorrelationId('tab\tchar')).toBeNull();
  });
});

describe('usageToolKind — expiry', () => {
  it('classifies the synthetic expiry tool as other', () => {
    expect(usageToolKind(EXPIRED_TOOL_NAME)).toBe('other');
  });
});

describe('period lists', () => {
  it('exposes the canonical token set', () => {
    expect([...USAGE_PERIODS]).toEqual(['24h', '7d', '30d', '90d', 'all']);
  });
});
