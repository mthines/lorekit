import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { UsageAttribution } from './UsageAttribution';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the usage-attribution panel — "who is
 * reading" (client) and "reads by agent family" (kind × host). The component
 * fetches over TanStack Query → `GET /memories/usage`, mocked per story since
 * the shared fixture set has no client/kind/host data to synthesise from.
 */
function usageHandler(byTool: Array<Record<string, unknown>>) {
  return http.get('*/functions/v1/memories/usage', () =>
    HttpResponse.json({
      range: { since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW },
      correlation_id: null,
      summary: { total_events: 0, reads: 0, writes: 0, other: 0, records_read: 0, archived: 0, expired: 0, by_outcome: {} },
      by_tool: byTool,
      by_scope_type: [],
      truncated: false,
    }),
  );
}

const LIVE_SHAPE_BY_TOOL = [
  { tool_name: 'memory.list', outcome: 'ok', scope_type: 'global', client: 'mcp', kind: 'lesson', host: 'reviewer', event_count: 4200, record_count: 130200, total_duration_ms: 1550000 },
  { tool_name: 'memory.search', outcome: 'ok', scope_type: 'repo', client: 'mcp', kind: 'lesson', host: 'aw', event_count: 1800, record_count: 5200, total_duration_ms: 694800 },
  { tool_name: 'memory.list', outcome: 'ok', scope_type: 'global', client: 'cli', kind: null, host: null, event_count: 320, record_count: 9600, total_duration_ms: 118400 },
  { tool_name: 'memory.write', outcome: 'ok', scope_type: 'repo', client: 'dashboard', kind: null, host: null, event_count: 80, record_count: 0, total_duration_ms: 8000 },
  { tool_name: 'memory.read', outcome: 'ok', scope_type: 'repo', client: null, kind: null, host: null, event_count: 15300, record_count: 15300, total_duration_ms: 1774800 },
];

const meta: Meta<typeof UsageAttribution> = {
  title: 'Lore/UsageAttribution',
  component: UsageAttribution,
  parameters: {
    layout: 'padded',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withQueryClient,
    (Story) => (
      <div style={{ maxWidth: '40rem' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    since: '2026-07-01T00:00:00.000Z',
    until: FROZEN_NOW,
  },
};

export default meta;
type Story = StoryObj<typeof UsageAttribution>;

/** Live production shape: a mix of attributed clients, one large unattributed (pre-default) bucket. */
export const Default: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), usageHandler(LIVE_SHAPE_BY_TOOL)] } },
};

/** No usage recorded in the window — the empty state. */
export const Empty: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), usageHandler([])] } },
};
