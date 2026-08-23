import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, userEvent, waitFor, fn } from 'storybook/test';

import { HotColdLore } from './HotColdLore';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link HotColdLore} — direction switching, the
 * counting_since qualifier (never the bare word "never"), and the groom
 * clipboard handoff.
 */
const COUNTING_SINCE = '2026-08-23T00:00:00.000Z';

const COLD_ENTRIES = [
  { id: '1', scope: 'repo::mthines/lorekit', key: 'never-used-fallback-branch', read_count: 0, last_read_at: null, seen_count: 1, created_at: '2026-01-05T00:00:00.000Z' },
];
const HOT_ENTRIES = [
  { id: '4', scope: 'repo::mthines/lorekit', key: 'prefer-server-actions', read_count: 214, last_read_at: FROZEN_NOW, seen_count: 6, created_at: '2026-01-01T00:00:00.000Z' },
];

function handler() {
  return http.get('*/functions/v1/memories/read-ranking', ({ request }) => {
    const url = new URL(request.url);
    const direction = url.searchParams.get('direction') ?? 'hot';
    return HttpResponse.json({
      direction,
      counting_since: COUNTING_SINCE,
      entries: direction === 'cold' ? COLD_ENTRIES : HOT_ENTRIES,
    });
  });
}

const meta: Meta<typeof HotColdLore> = {
  title: 'Lore/HotColdLore/Tests',
  component: HotColdLore,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler()] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof HotColdLore>;

export const ColdIsTheDefaultAndNeverSaysNever: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('opens on Cold, showing the never-read entry with the counting_since qualifier', async () => {
      await waitFor(() => expect(canvas.getByText('never-used-fallback-branch')).toBeVisible());
      await expect(canvas.getByText('read 0×')).toBeVisible();
      // The qualifying caption must name the cutover date...
      await expect(canvas.getByText(/not read since tracking began on/i)).toBeVisible();
      // ...and must NEVER render the bare, unqualified word "never".
      await expect(canvas.queryByText(/^never$/i)).not.toBeInTheDocument();
    });
  },
};

export const SwitchingToHotShowsTheMostRead: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('never-used-fallback-branch')).toBeVisible());
    await step('clicking Hot switches to the most-read ranking', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /most-read lore/i }));
      await waitFor(() => expect(canvas.getByText('prefer-server-actions')).toBeVisible());
      await expect(canvas.getByText(/read 214×/)).toBeVisible();
      await expect(canvas.queryByText('never-used-fallback-branch')).not.toBeInTheDocument();
    });
  },
};

export const CopyForGroomCopiesScopeKeyLines: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('never-used-fallback-branch')).toBeVisible());
    const writeText = fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await step('Copy for groom copies scope::key lines and confirms', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /copy for groom/i }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('repo::mthines/lorekit::never-used-fallback-branch'));
      await expect(canvas.getByRole('button', { name: /copied/i })).toBeVisible();
    });
  },
};
