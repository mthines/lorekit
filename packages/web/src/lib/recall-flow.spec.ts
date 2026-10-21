import { describe, expect, it } from 'vitest';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { recallFlow } from './recall-flow';

function row(overrides: Partial<UsageStatRow>): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'repo',
    client: 'mcp',
    kind: 'lesson',
    host: 'claude',
    event_count: 1,
    record_count: 1,
    total_duration_ms: 10,
    ...overrides,
  };
}

describe('recallFlow', () => {
  it('keeps only the four lore-read tools and counts calls, not records', () => {
    const flow = recallFlow([
      row({ tool_name: 'memory.list', event_count: 10, record_count: 600 }),
      row({ tool_name: 'memory.write', event_count: 99 }),
      row({ tool_name: 'memory.scopes', event_count: 50 }),
      row({ tool_name: 'org.list', event_count: 50 }),
    ]);
    expect(flow.totalCalls).toBe(10);
    expect(flow.rows).toEqual([{ client: 'mcp', tool: 'memory.list', scopeType: 'repo', calls: 10 }]);
  });

  it('counts only successful calls — a failed read recalled nothing', () => {
    const flow = recallFlow([
      row({ tool_name: 'memory.read', event_count: 5 }),
      row({ tool_name: 'memory.read', outcome: 'error', event_count: 9 }),
    ]);
    expect(flow.totalCalls).toBe(5);
  });

  it('names an unattributed client and buckets unknown scope types', () => {
    const flow = recallFlow([row({ client: null, scope_type: null, event_count: 3 })]);
    expect(flow.rows[0]).toMatchObject({ client: 'unattributed', scopeType: 'other' });
  });

  it('conserves flow through the middle column', () => {
    const flow = recallFlow([
      row({ client: 'mcp', tool_name: 'memory.list', scope_type: 'repo', event_count: 7 }),
      row({ client: 'cli', tool_name: 'memory.list', scope_type: 'global', event_count: 3 }),
      row({ client: 'dashboard', tool_name: 'memory.read', scope_type: 'branch', event_count: 2 }),
    ]);
    const into = (id: string) => flow.links.filter((l) => l.target === id).reduce((s, l) => s + l.value, 0);
    const out = (id: string) => flow.links.filter((l) => l.source === id).reduce((s, l) => s + l.value, 0);
    expect(into('t:memory.list')).toBe(10);
    expect(out('t:memory.list')).toBe(10);
    expect(into('t:memory.read')).toBe(out('t:memory.read'));
  });

  it('folds clients past the top N into "other", listed last', () => {
    const flow = recallFlow(
      [
        row({ client: 'a', event_count: 9 }),
        row({ client: 'b', event_count: 8 }),
        row({ client: 'c', event_count: 1 }),
        row({ client: 'd', event_count: 1 }),
      ],
      2,
    );
    const clients = flow.nodes.filter((n) => n.layer === 0).map((n) => n.label);
    expect(clients).toEqual(['a', 'b', 'other']);
    expect(flow.rows.find((r) => r.client === 'other')?.calls).toBe(2);
  });

  it('is empty for an account with no reads', () => {
    expect(recallFlow([])).toEqual({ nodes: [], links: [], rows: [], totalCalls: 0 });
  });
});
