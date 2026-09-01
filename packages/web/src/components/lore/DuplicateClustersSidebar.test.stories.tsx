import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { DuplicateClustersSidebar } from './DuplicateClustersSidebar';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { clusterId } from '@/lib/duplicate-clusters-view';
import type { ClustersResponse, DuplicateCluster } from '@lorekit/schemas/memory';

/**
 * Interaction tests for {@link DuplicateClustersSidebar}. Three behaviours, none
 * of which a screenshot can see:
 *
 *  1. **Picking a cluster hands the WHOLE cluster back to the parent**, and
 *     re-picking the held one clears the selection — the parent (`LoreExplorer`)
 *     is what re-points the results list, this component only ever reports the
 *     choice by value (see `clusterId`'s docblock on why identity is derived,
 *     not a server id).
 *  2. **Closing calls `onClose`** — getting rid of the sidebar is the parent's
 *     job too (it owns `open`), so this only ever asks.
 *  3. **The honest labels render**: a partial class match is labelled partial,
 *     the similarity range says "linked at", and a saturated window says which
 *     question it answered.
 *
 * The old member-stepper tests (`StepsThroughMembersAndClampsAtTheEnds`,
 * `OpensTheSelectedMemberAsALesson`) are gone along with the stepper itself —
 * opening a member is now the Explorer's own list (`LessonCard`), driven by
 * `LoreExplorer`'s `renderResults`, not a nested detail pane in this sidebar.
 */

function member(scope: string, key: string, hook: string, seen: number) {
  return { scope, key, hook, seen_count: seen, updated_at: FROZEN_NOW, status: null };
}

const FIRST: DuplicateCluster = {
  size: 3,
  score: 42,
  min_similarity: 0.86,
  max_similarity: 0.97,
  recurrence_class: {
    id: 'edge-mirror-drift',
    name: 'Edge mirror drift',
    matched: ['alpha', 'beta'],
    // Deliberately IMPURE: 2 of 3 members resolve, so the sidebar must say
    // "partial" rather than presenting the class as the whole cluster.
    pure: false,
  },
  members: [
    member('global', 'alpha', 'The first lesson in the cluster.', 9),
    member('global', 'beta', 'The second lesson in the cluster.', 4),
    member('repo::mthines/lorekit', 'gamma', 'The third lesson in the cluster.', 1),
  ],
};

const SECOND: DuplicateCluster = {
  size: 2,
  score: 5,
  min_similarity: 0.92,
  max_similarity: 0.92,
  recurrence_class: null,
  members: [
    member('global', 'delta', 'A lesson in the second cluster.', 3),
    member('global', 'epsilon', 'Another lesson in the second cluster.', 2),
  ],
};

function body(over: Partial<ClustersResponse> = {}): ClustersResponse {
  return { threshold: 0.8, candidates: 40, candidate_limit: 150, clusters: [FIRST, SECOND], ...over };
}

function handler(over: Partial<ClustersResponse> = {}) {
  return http.get('*/functions/v1/memories/clusters', () => HttpResponse.json(body(over)));
}

const onSelectCluster = fn().mockName('onSelectCluster');
const onClose = fn().mockName('onClose');

const meta: Meta<typeof DuplicateClustersSidebar> = {
  title: 'Lore/DuplicateClustersSidebar/Tests',
  component: DuplicateClustersSidebar,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler()] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClustersSidebar>;

function sidebar(selectedClusterId: string | null = null) {
  return (
    <DuplicateClustersSidebar
      scope="global"
      scopeLabel="global"
      selectedClusterId={selectedClusterId}
      onSelectCluster={onSelectCluster}
      onClose={onClose}
    />
  );
}

export const SelectingAClusterNotifiesTheParent: Story = {
  render: () => {
    onSelectCluster.mockClear();
    return sidebar(null);
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('picking a cluster hands the whole cluster back, by value', async () => {
      const radio = await canvas.findByRole('radio', { name: /2 lessons/ });
      await userEvent.click(radio);
      await expect(onSelectCluster).toHaveBeenCalledTimes(1);
      const [picked] = onSelectCluster.mock.calls[0] as [DuplicateCluster];
      await expect(picked.members.map((m) => m.key)).toEqual(['delta', 'epsilon']);
    });
  },
};

export const ReselectingTheHeldClusterClearsIt: Story = {
  render: () => {
    onSelectCluster.mockClear();
    return sidebar(clusterId(SECOND));
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the held cluster shows as checked', async () => {
      const radio = await canvas.findByRole('radio', { name: /2 lessons/ });
      await expect(radio).toHaveAttribute('aria-checked', 'true');
    });

    await step('clicking it again clears the selection', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /2 lessons/ }));
      await expect(onSelectCluster).toHaveBeenCalledWith(null);
    });
  },
};

export const ClosingAsksTheParent: Story = {
  render: () => {
    onClose.mockClear();
    return sidebar(null);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Hide duplicate clusters' }));
    await expect(onClose).toHaveBeenCalledTimes(1);
  },
};

export const SaysWhatItDoesNotKnow: Story = {
  parameters: {
    // A FULL candidate window, which is the state the footnote has to qualify.
    msw: { handlers: [...memoryHandlers(), handler({ candidates: 150 })] },
  },
  render: () => sidebar(null),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a partial class match is labelled partial, never as the cluster itself', async () => {
      await waitFor(() => expect(canvas.getByText('Edge mirror drift')).toBeVisible());
      await expect(canvas.getByText(/partial · 2 of 3 match/)).toBeVisible();
    });

    await step('the similarity range says LINKED AT, not "every pair is at least"', async () => {
      await expect(canvas.getByText(/linked at 86–97% alike/)).toBeVisible();
    });

    await step('a saturated window says which question it answered', async () => {
      const note = canvas.getByText(/Read-only — nothing here merges/);
      await expect(note).toBeVisible();
      await expect(note).toHaveTextContent(/150 most recently updated lessons/);
      await expect(note).toHaveTextContent(/lorekit dedupe/);
    });
  },
};
