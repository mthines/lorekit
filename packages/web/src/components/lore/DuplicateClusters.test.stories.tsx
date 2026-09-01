import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { DuplicateClusters } from './DuplicateClusters';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * Interaction tests for the Duplicate Clusters TRIGGER bar.
 *
 * The trigger itself has two behaviours worth an interaction test, neither of
 * which a screenshot can prove:
 *
 *  1. **Folded means NOT FETCHED.** `open` gates the summary query, which is
 *     the reason the disclosure exists at all — the server reads clusters'
 *     full bodies and is quadratic in the worst case.
 *  2. **Toggling calls back to the parent, not local state.** The trigger holds
 *     no `open` state of its own — `LoreExplorer` does, because the sidebar it
 *     reveals needs the exact same boolean — so a click must invoke
 *     `onToggleOpen` rather than flip anything internally.
 *
 * Cluster SELECTION, the member list, and the honest labels all moved to
 * `DuplicateClustersSidebar.test.stories.tsx`, alongside the component that now
 * actually renders them.
 */

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

/** Records whether the route was reached at all — the folded-means-not-fetched assertion. */
const clustersSeen = fn();

const handler = http.get('*/functions/v1/memories/clusters', () => {
  clustersSeen();
  return HttpResponse.json(BODY);
});

/** Records the hand-off to the parent, which owns `open` — see the docblock. */
const onToggleOpenSpy = fn().mockName('onToggleOpen');

const meta: Meta<typeof DuplicateClusters> = {
  title: 'Lore/DuplicateClusters/Tests',
  component: DuplicateClusters,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClusters>;

/**
 * Plays the parent's part: the real `open` prop is `LoreExplorer`'s state, so
 * this small wrapper is what makes a click's EFFECT (a fetch, the summary
 * badge) visible in the test, without giving the trigger any state of its own.
 */
function ControlledTrigger(props: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  return (
    <DuplicateClusters
      scope="global"
      scopeLabel="global"
      open={open}
      onToggleOpen={() => {
        onToggleOpenSpy();
        setOpen((value) => !value);
      }}
    />
  );
}

export const FoldedMeansNotFetched: Story = {
  render: () => {
    clustersSeen.mockClear();
    return <ControlledTrigger initialOpen={false} />;
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('collapsed: no request reaches the route', async () => {
      const toggle = await canvas.findByRole('button', { name: /duplicate clusters/i });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Give the query a chance to fire if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });

    await step('opening calls back to the parent, and the resulting fetch is not vacuous', async () => {
      onToggleOpenSpy.mockClear();
      await userEvent.click(canvas.getByRole('button', { name: /duplicate clusters/i }));
      await expect(onToggleOpenSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(clustersSeen).toHaveBeenCalled());
      await waitFor(() => expect(canvas.getByText(/1 cluster/)).toBeVisible());
    });
  },
};

export const ShowsASummaryOnceOpen: Story = {
  render: () => <ControlledTrigger initialOpen={true} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => expect(canvas.getByText('1 cluster · 2 lessons')).toBeVisible());
    await expect(canvas.getByRole('button', { name: /duplicate clusters/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};
