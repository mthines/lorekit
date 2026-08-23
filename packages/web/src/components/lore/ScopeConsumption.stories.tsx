import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { ScopeConsumption } from './ScopeConsumption';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the scope consumption leaderboard.
 *
 * The component fetches over TanStack Query → `GET /memories/read-activity`,
 * which MSW mocks, so these render the REAL component against a realistic
 * dataset. `memoryHandlers()`'s own read-activity fixture never emits a
 * null-scope row (by its own docblock — a synthesised read always knows its
 * source memory), so the "with unattributed reads" story overrides that one
 * handler with a fixture that includes one, matching production shape.
 */
const meta: Meta<typeof ScopeConsumption> = {
  title: 'Lore/ScopeConsumption',
  component: ScopeConsumption,
  parameters: {
    layout: 'padded',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withQueryClient,
    (Story) => (
      <div style={{ maxWidth: '32rem' }}>
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
type Story = StoryObj<typeof ScopeConsumption>;

/** The fixture's real scope breakdown — every row is attributed. */
export const Default: Story = {};

/**
 * Live production shape: a handful of named scopes plus a large unattributed
 * bucket (~40% of records, mostly `memory.search`) — the case the "must be
 * shown, labelled honestly" requirement exists for.
 */
export const WithUnattributedReads: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({
            bucket: 'day',
            since: '2026-07-01T00:00:00.000Z',
            until: FROZEN_NOW,
            buckets: [
              { bucket: '2026-07-05T00:00:00.000Z', scope: 'repo::mthines/lorekit', count: 58631 },
              { bucket: '2026-07-05T00:00:00.000Z', scope: 'global', count: 110187 },
              { bucket: '2026-07-05T00:00:00.000Z', scope: 'project::lorekit-web-daily-report', count: 854 },
              { bucket: '2026-07-05T00:00:00.000Z', scope: 'branch::mthines/lorekit::feat/x', count: 15 },
              { bucket: '2026-07-05T00:00:00.000Z', scope: null, count: 145260 },
            ],
          }),
        ),
      ],
    },
  },
};

/** No reads in the window — the empty state, not a zero-filled leaderboard. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/read-activity', () =>
          HttpResponse.json({ bucket: 'day', since: '2026-07-01T00:00:00.000Z', until: FROZEN_NOW, buckets: [] }),
        ),
      ],
    },
  },
};
