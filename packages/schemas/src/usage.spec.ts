import { describe, it, expect } from 'vitest';
import {
  UsageStatsQuerySchema,
  UsageStatsResponseSchema,
  USAGE_PERIODS,
} from './usage.ts';

describe('UsageStatsQuerySchema', () => {
  it('accepts an empty query (all-time)', () => {
    expect(UsageStatsQuerySchema.parse({})).toEqual({});
  });

  it('accepts each period token', () => {
    for (const period of USAGE_PERIODS) {
      expect(UsageStatsQuerySchema.parse({ period }).period).toBe(period);
    }
  });

  it('rejects an unknown period', () => {
    expect(UsageStatsQuerySchema.safeParse({ period: '1y' }).success).toBe(false);
  });

  it('accepts ISO since/until with offset', () => {
    const parsed = UsageStatsQuerySchema.parse({
      since: '2026-07-01T00:00:00Z',
      until: '2026-07-31T00:00:00+00:00',
    });
    expect(parsed.since).toBe('2026-07-01T00:00:00Z');
  });

  it('rejects a non-ISO since', () => {
    expect(UsageStatsQuerySchema.safeParse({ since: '2026-07-01' }).success).toBe(false);
  });

  it('accepts a bounded correlation_id', () => {
    expect(UsageStatsQuerySchema.parse({ correlation_id: 'mthines/lorekit#123' }).correlation_id)
      .toBe('mthines/lorekit#123');
    expect(UsageStatsQuerySchema.safeParse({ correlation_id: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('UsageStatsResponseSchema', () => {
  it('validates a well-formed response', () => {
    const ok = UsageStatsResponseSchema.safeParse({
      range: { since: '2026-07-24T12:00:00.000Z', until: null },
      correlation_id: 'pr-42',
      summary: { total_events: 3, reads: 2, writes: 1, other: 0, records_read: 20, expired: 0, by_outcome: { ok: 3 } },
      by_tool: [
        { tool_name: 'memory.list', outcome: 'ok', scope_type: 'repo', event_count: 2, record_count: 20, total_duration_ms: 10 },
        { tool_name: 'memory.write', outcome: 'ok', scope_type: null, event_count: 1, record_count: 0, total_duration_ms: null },
      ],
      by_scope_type: [{ scope_type: 'repo', event_count: 2 }, { scope_type: null, event_count: 1 }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a negative count', () => {
    const bad = UsageStatsResponseSchema.safeParse({
      range: { since: null, until: null },
      correlation_id: null,
      summary: { total_events: -1, reads: 0, writes: 0, other: 0, records_read: 0, expired: 0, by_outcome: {} },
      by_tool: [],
      by_scope_type: [],
    });
    expect(bad.success).toBe(false);
  });
});
