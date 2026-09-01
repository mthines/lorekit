import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, waitFor, within } from 'storybook/test';

import { DuplicateClustersSidebarPanel } from './DuplicateClustersSidebarPanel';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withFlagVariants } from '@/mocks/decorators';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * The FLAG gate on the Duplicate Clusters SIDEBAR — `DuplicateClustersSidebarPanel`
 * is `DuplicateClustersPanel`'s sibling resolver for the same
 * `lore-explorer-duplicate-clusters` flag (see its own docblock for why the two
 * render sites get one resolver each rather than sharing one).
 *
 * Two independent gates compose here too, and the `open`-seeded-true trick from
 * `DuplicateClustersPanel.test.stories.tsx` proves the same thing on this half:
 * a flagged-off sidebar must fetch and render NOTHING even when `open` is the
 * state that would normally reveal it.
 */

const clustersSeen = fn();

const BODY: ClustersResponse = {
  threshold: 0.8,
  candidates: 40,
  candidate_limit: 150,
  clusters: [
    {
      size: 2,
      score: 7,
      min_similarity: 0.9,
      max_similarity: 0.9,
      recurrence_class: null,
      members: [
        { scope: 'global', key: 'alpha', hook: 'First.', seen_count: 4, updated_at: FROZEN_NOW, status: null },
        { scope: 'global', key: 'beta', hook: 'Second.', seen_count: 3, updated_at: FROZEN_NOW, status: null },
      ],
    },
  ],
};

const handler = http.get('*/functions/v1/memories/clusters', () => {
  clustersSeen();
  return HttpResponse.json(BODY);
});

const meta: Meta<typeof DuplicateClustersSidebarPanel> = {
  title: 'Lore/DuplicateClustersSidebarPanel/Tests',
  component: DuplicateClustersSidebarPanel,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClustersSidebarPanel>;

/** `open` seeded true in every story — so "did not render/fetch" can only be the flag. */
function panel() {
  clustersSeen.mockClear();
  return (
    <DuplicateClustersSidebarPanel
      open={true}
      scope="global"
      scopeLabel="global"
      selectedClusterId={null}
      onSelectCluster={fn()}
      onClose={fn()}
    />
  );
}

export const FlagOffRendersNothingAndFetchesNothing: Story = {
  // No override — the registry default (`off`) is exactly what is under test.
  decorators: [withFlagVariants({})],
  render: panel,
  play: async ({ canvasElement, step }) => {
    await step('nothing mounted, even with open seeded true', async () => {
      await expect(canvasElement.querySelector('aside')).toBeNull();
    });

    await step('and nothing was requested', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });
  },
};

export const FlagOnRendersTheSidebar: Story = {
  decorators: [withFlagVariants({ 'lore-explorer-duplicate-clusters': 'on' })],
  render: panel,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(clustersSeen).toHaveBeenCalled());
    await expect(canvasElement.querySelector('aside')).not.toBeNull();
    await waitFor(() => expect(canvas.getByText('alpha, beta')).toBeVisible());
  },
};

/**
 * An unknown variant — a stale override cookie, or a variant renamed in the
 * registry — must fall to OFF, never render.
 */
export const UnknownVariantFallsToOff: Story = {
  decorators: [withFlagVariants({ 'lore-explorer-duplicate-clusters': 'experimental-arm' })],
  render: panel,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('aside')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(clustersSeen).not.toHaveBeenCalled();
  },
};
