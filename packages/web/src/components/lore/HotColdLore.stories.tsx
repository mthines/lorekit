import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { HotColdLore } from './HotColdLore';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import type { ReadRankingEntry } from '@lorekit/schemas/memory';

/**
 * Visual-regression stories for the hot/cold lore ranking panel. The
 * component fetches over TanStack Query → `GET /memories/read-ranking`,
 * mocked per story since the shared `memoryHandlers()` fixture set has no
 * read_count data to synthesise a ranking from.
 */
const COUNTING_SINCE = '2026-08-23T00:00:00.000Z';

const COLD_ENTRIES: ReadRankingEntry[] = [
  { id: '1', scope: 'repo::mthines/lorekit', key: 'never-used-fallback-branch', read_count: 0, last_read_at: null, seen_count: 1, created_at: '2026-01-05T00:00:00.000Z' },
  { id: '2', scope: 'global', key: 'legacy-formatting-rule', read_count: 0, last_read_at: null, seen_count: 3, created_at: '2026-02-10T00:00:00.000Z' },
  { id: '3', scope: 'project::lorekit-web', key: 'old-onboarding-copy', read_count: 0, last_read_at: null, seen_count: 1, created_at: '2026-03-01T00:00:00.000Z' },
];

const HOT_ENTRIES: ReadRankingEntry[] = [
  { id: '4', scope: 'repo::mthines/lorekit', key: 'prefer-server-actions', read_count: 214, last_read_at: FROZEN_NOW, seen_count: 6, created_at: '2026-01-01T00:00:00.000Z' },
  { id: '5', scope: 'global', key: 'always-worktree-isolation', read_count: 98, last_read_at: FROZEN_NOW, seen_count: 12, created_at: '2026-01-02T00:00:00.000Z' },
];

function handlerFor(direction: 'hot' | 'cold', entries: ReadRankingEntry[]) {
  return http.get('*/functions/v1/memories/read-ranking', ({ request }) => {
    const url = new URL(request.url);
    const requested = url.searchParams.get('direction') ?? 'hot';
    return HttpResponse.json({
      direction: requested,
      counting_since: COUNTING_SINCE,
      entries: requested === direction ? entries : [],
    });
  });
}

const meta: Meta<typeof HotColdLore> = {
  title: 'Lore/HotColdLore',
  component: HotColdLore,
  parameters: { layout: 'padded' },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withQueryClient,
    (Story) => (
      <div style={{ maxWidth: '40rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof HotColdLore>;

/** Opens on Cold (the default direction) — the prune-list view. */
export const Default: Story = {
  parameters: {
    msw: { handlers: [...memoryHandlers(), handlerFor('cold', COLD_ENTRIES), handlerFor('hot', HOT_ENTRIES)] },
  },
};

/** No memories to rank at all — the empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/read-ranking', () =>
          HttpResponse.json({ direction: 'cold', counting_since: COUNTING_SINCE, entries: [] }),
        ),
      ],
    },
  },
};
