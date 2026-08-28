import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { RunsList } from './RunsList';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the Settings → Runs list — the payoff view
 * for `GET /memories/usage?correlation_id=`.
 */
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
  {
    correlation_id: 'ci:mthines/lorekit#918273',
    session_kind: 'ci',
    first_seen: '2026-08-19T22:10:00.000Z',
    last_seen: '2026-08-19T22:11:30.000Z',
    read_events: 4,
    records_read: 90,
    write_events: 0,
    distinct_scopes: 1,
    total_duration_ms: 12_400,
  },
  {
    correlation_id: 'session:a1b2c3',
    session_kind: 'local',
    first_seen: '2026-08-18T14:00:00.000Z',
    last_seen: '2026-08-18T15:20:00.000Z',
    read_events: 58,
    records_read: 1_820,
    write_events: 6,
    distinct_scopes: 5,
    total_duration_ms: 4_812_000,
  },
];

function handlers() {
  return [
    ...memoryHandlers(),
    http.get('*/functions/v1/memories/usage/runs', () =>
      HttpResponse.json({
        range: { since: '2026-05-20T00:00:00.000Z', until: FROZEN_NOW },
        runs: RUNS,
        next_cursor: null,
      }),
    ),
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      const correlationId = url.searchParams.get('correlation_id');
      return HttpResponse.json({
        range: { since: null, until: null },
        correlation_id: correlationId,
        summary: {
          total_events: 14, reads: 12, writes: 2, other: 0,
          records_read: 340, archived: 0, expired: 0, by_outcome: { ok: 14 },
        },
        by_tool: [],
        by_scope_type: [],
      });
    }),
  ];
}

const meta: Meta<typeof RunsList> = {
  title: 'Settings/RunsList',
  component: RunsList,
  parameters: { layout: 'padded', msw: { handlers: handlers() } },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withQueryClient,
    (Story) => (
      <div style={{ maxWidth: '48rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof RunsList>;

export const Default: Story = {};

export const NoRuns: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/usage/runs', () =>
          HttpResponse.json({ range: { since: '2026-05-20T00:00:00.000Z', until: FROZEN_NOW }, runs: [], next_cursor: null }),
        ),
      ],
    },
  },
};
