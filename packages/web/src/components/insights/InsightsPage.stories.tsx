import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import type { ReadRankingEntry } from '@lorekit/schemas/memory';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { InsightsPage } from './InsightsPage';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Full-page visual-regression stories for `/insights` — the consolidated
 * consumption/usage view. Composes five already-storied components
 * (`UsageHealth`, `AgentBreakdown`, `ScopeConsumption`, `HotColdLore`,
 * `RunsList`), each of which fetches over TanStack Query → a REST endpoint
 * MSW mocks here, so this stories the real page against a realistic dataset.
 *
 * `by_tool` is populated (unlike the shared `memoryHandlers()` default, which
 * is `[]`) so Operational health / Who's reading render real diagnostics
 * rather than their empty state.
 */

function row(overrides: Partial<UsageStatRow> = {}): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'global',
    event_count: 1,
    record_count: 1,
    total_duration_ms: 100,
    client: 'mcp',
    kind: 'lesson',
    host: 'claude',
    ...overrides,
  };
}

const BY_TOOL: UsageStatRow[] = [
  row({ tool_name: 'org.create', outcome: 'error', scope_type: null, event_count: 155, record_count: 0, total_duration_ms: 46_500, client: null, kind: null, host: null }),
  row({ tool_name: 'memory.search', scope_type: 'global', event_count: 100, total_duration_ms: 38_600, record_count: 3_100 }),
  row({ tool_name: 'memory.list', scope_type: 'branch', event_count: 1_176, total_duration_ms: 229_000, record_count: 15, client: 'cli', host: 'aw' }),
  row({ tool_name: 'memory.read', scope_type: 'repo', event_count: 200, total_duration_ms: 23_200, record_count: 200, client: 'dashboard', host: 'dashboard' }),
];

const COLD_ENTRIES: ReadRankingEntry[] = [
  { id: '1', scope: 'repo::mthines/lorekit', key: 'never-used-fallback-branch', read_count: 0, last_read_at: null, seen_count: 1, created_at: '2026-01-05T00:00:00.000Z' },
  { id: '2', scope: 'global', key: 'legacy-formatting-rule', read_count: 0, last_read_at: null, seen_count: 3, created_at: '2026-02-10T00:00:00.000Z' },
];

const RUNS = [
  {
    correlation_id: 'pr:mthines/lorekit#482',
    session_kind: 'pr',
    first_seen: '2026-08-20T09:00:00.000Z',
    last_seen: '2026-08-20T09:42:00.000Z',
    read_events: 12,
    records_read: 340,
    write_events: 2,
    distinct_scopes: 3,
    total_duration_ms: 184_200,
  },
];

function handlers() {
  // MSW resolves handlers in list order (first match wins), so every
  // override below must come BEFORE `...memoryHandlers()` or its own
  // (empty) usage fixture always wins instead.
  return [
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json({
        range: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
        correlation_id: null,
        summary: {
          total_events: 1_631, reads: 1_476, writes: 155, other: 0,
          records_read: 3_315, archived: 0, expired: 0,
          by_outcome: { ok: 1_476, error: 155 },
        },
        by_tool: BY_TOOL,
        by_scope_type: [],
      });
    }),
    http.get('*/functions/v1/memories/read-ranking', ({ request }) => {
      const direction = new URL(request.url).searchParams.get('direction') ?? 'cold';
      return HttpResponse.json({
        direction,
        counting_since: '2026-08-23T00:00:00.000Z',
        entries: direction === 'cold' ? COLD_ENTRIES : [],
      });
    }),
    http.get('*/functions/v1/memories/usage/runs', () =>
      HttpResponse.json({ range: { since: '2026-05-20T00:00:00.000Z', until: FROZEN_NOW }, runs: RUNS, next_cursor: null }),
    ),
    ...memoryHandlers(),
  ];
}

const meta: Meta<typeof InsightsPage> = {
  title: 'Pages/Insights',
  component: InsightsPage,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: handlers() },
    // ScopeConsumption's local RangePicker and RunsList both need the App
    // Router context — same reason DashboardStats.stories.tsx sets it.
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  render: () => (
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <InsightsPage />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof InsightsPage>;

/** All five sections populated with realistic data. */
export const Default: Story = {};

/** An account with no usage recorded yet — every section renders its empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers([]),
        http.get('*/functions/v1/memories/read-ranking', ({ request }) =>
          HttpResponse.json({
            direction: new URL(request.url).searchParams.get('direction') ?? 'cold',
            counting_since: '2026-08-23T00:00:00.000Z',
            entries: [],
          }),
        ),
        http.get('*/functions/v1/memories/usage/runs', () =>
          HttpResponse.json({ range: { since: null, until: FROZEN_NOW }, runs: [], next_cursor: null }),
        ),
      ],
    },
  },
};
