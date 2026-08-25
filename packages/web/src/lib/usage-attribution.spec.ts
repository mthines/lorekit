import { describe, it, expect } from 'vitest';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { attributionByClient, attributionByAgentFamily } from './usage-attribution';

function row(overrides: Partial<UsageStatRow> = {}): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'global',
    client: null,
    kind: null,
    host: null,
    event_count: 1,
    record_count: 1,
    total_duration_ms: 100,
    ...overrides,
  };
}

describe('attributionByClient', () => {
  it('sums event_count per client', () => {
    const rows = [row({ client: 'mcp', event_count: 10 }), row({ client: 'mcp', event_count: 5 }), row({ client: 'cli', event_count: 3 })];
    expect(attributionByClient(rows)).toEqual([
      { client: 'mcp', event_count: 15 },
      { client: 'cli', event_count: 3 },
    ]);
  });

  it('keeps the null (unattributed) client as its own row', () => {
    const rows = [row({ client: null, event_count: 40 }), row({ client: 'api', event_count: 5 })];
    expect(attributionByClient(rows)).toContainEqual({ client: null, event_count: 40 });
  });

  it('ranks descending', () => {
    const rows = [row({ client: 'api', event_count: 1 }), row({ client: 'dashboard', event_count: 99 })];
    expect(attributionByClient(rows).map((r) => r.client)).toEqual(['dashboard', 'api']);
  });
});

describe('attributionByAgentFamily', () => {
  it('sums event_count per (kind, host)', () => {
    const rows = [
      row({ kind: 'lesson', host: 'reviewer', event_count: 10 }),
      row({ kind: 'lesson', host: 'reviewer', event_count: 5 }),
      row({ kind: 'lesson', host: 'aw', event_count: 2 }),
    ];
    expect(attributionByAgentFamily(rows)).toEqual([
      { kind: 'lesson', host: 'reviewer', event_count: 15 },
      { kind: 'lesson', host: 'aw', event_count: 2 },
    ]);
  });

  it('collapses every null-kind/null-host row into one bucket rather than fragmenting', () => {
    const rows = [
      row({ kind: null, host: null, event_count: 5 }),
      row({ kind: null, host: null, event_count: 3 }),
    ];
    expect(attributionByAgentFamily(rows)).toEqual([{ kind: null, host: null, event_count: 8 }]);
  });

  it('ranks descending', () => {
    const rows = [
      row({ kind: 'bus', host: 'review', event_count: 1 }),
      row({ kind: 'lesson', host: 'aw', event_count: 50 }),
    ];
    expect(attributionByAgentFamily(rows).map((r) => r.host)).toEqual(['aw', 'review']);
  });
});
