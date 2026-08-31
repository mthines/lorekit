import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { DuplicateClusters } from './DuplicateClusters';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { writePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * Interaction tests for {@link DuplicateClusters}. Four behaviours, none of which
 * a screenshot can see:
 *
 *  1. **Folded means NOT FETCHED.** The panel's query is gated on its own
 *     disclosure, which is the reason that disclosure exists at all — the server
 *     read clusters full bodies and is quadratic in the worst case. A spy on the
 *     mocked route proves it, and the same spy proves the assertion is not
 *     vacuous by firing once the panel is expanded.
 *  2. **Selection is resolved by VALUE**, so stepping through a cluster's members
 *     behaves and prev/next CLAMP at the ends rather than wrapping past the
 *     visible "N of M".
 *  3. **A member opens the lesson** — getting from "these look duplicated" to the
 *     lore itself is the panel's whole point.
 *  4. **The honest labels render**: a partial class match is labelled partial, the
 *     similarity range says "linked at", and a saturated window says which
 *     question it answered.
 */

function member(scope: string, key: string, hook: string, seen: number) {
  return { scope, key, hook, seen_count: seen, updated_at: FROZEN_NOW, status: null };
}

const FIRST = {
  size: 3,
  score: 42,
  min_similarity: 0.86,
  max_similarity: 0.97,
  recurrence_class: {
    id: 'edge-mirror-drift',
    name: 'Edge mirror drift',
    matched: ['alpha', 'beta'],
    // Deliberately IMPURE: 2 of 3 members resolve, so the panel must say
    // "partial" rather than presenting the class as the whole cluster.
    pure: false,
  },
  members: [
    member('global', 'alpha', 'The first lesson in the cluster.', 9),
    member('global', 'beta', 'The second lesson in the cluster.', 4),
    member('repo::mthines/lorekit', 'gamma', 'The third lesson in the cluster.', 1),
  ],
};

const SECOND = {
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

/** Records whether the route was reached at all — story 1's whole assertion. */
const clustersSeen = fn();

function handler(over: Partial<ClustersResponse> = {}) {
  return http.get('*/functions/v1/memories/clusters', () => {
    clustersSeen();
    return HttpResponse.json(body(over));
  });
}

/** The prop spy for story 3. Cleared in `render` so a re-run starts empty. */
const openLessonSpy = fn();

const meta: Meta<typeof DuplicateClusters> = {
  title: 'Lore/DuplicateClusters/Tests',
  component: DuplicateClusters,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler()] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClusters>;

/** Seeded EXPANDED — the default is collapsed, and story 1 covers that path. */
function expanded(onOpenLesson: (ref: { scope: string; key: string }) => void = () => {}) {
  writePersistedPreference(PREFERENCE_KEYS.explorerClustersOpen, '1');
  return <DuplicateClusters scope="global" scopeLabel="global" onOpenLesson={onOpenLesson} />;
}

export const FoldedMeansNotFetched: Story = {
  render: () => {
    clustersSeen.mockClear();
    // Explicitly collapsed rather than relying on the default, so this test
    // cannot start passing for the wrong reason if that default ever flips.
    writePersistedPreference(PREFERENCE_KEYS.explorerClustersOpen, '0');
    return <DuplicateClusters scope="global" scopeLabel="global" onOpenLesson={() => {}} />;
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('collapsed: no request reaches the route', async () => {
      const toggle = await canvas.findByRole('button', { name: 'Show duplicate clusters' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Give the query a chance to fire if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });

    await step('expanding fetches — so the assertion above was not vacuous', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Show duplicate clusters' }));
      await waitFor(() => expect(clustersSeen).toHaveBeenCalled());
      await waitFor(() => expect(canvas.getByText('alpha')).toBeVisible());
    });
  },
};

export const StepsThroughMembersAndClampsAtTheEnds: Story = {
  render: () => expanded(),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the highest-ranked cluster is selected, showing its members', async () => {
      await waitFor(() => expect(canvas.getByText('alpha')).toBeVisible());
      await expect(canvas.getByText('beta')).toBeVisible();
      await expect(canvas.getByText('gamma')).toBeVisible();
      await expect(canvas.getByText('1 of 3')).toBeVisible();
      await expect(canvas.getByText('The first lesson in the cluster.')).toBeVisible();
    });

    await step('prev is disabled on the first member — clamped, not wrapping', async () => {
      await expect(
        canvas.getByRole('button', { name: 'Previous lesson in this cluster' }),
      ).toBeDisabled();
    });

    await step('next steps forward', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Next lesson in this cluster' }));
      await waitFor(() => expect(canvas.getByText('2 of 3')).toBeVisible());
      await expect(canvas.getByText('The second lesson in the cluster.')).toBeVisible();
    });

    await step('next is disabled on the last member', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Next lesson in this cluster' }));
      await waitFor(() => expect(canvas.getByText('3 of 3')).toBeVisible());
      await expect(
        canvas.getByRole('button', { name: 'Next lesson in this cluster' }),
      ).toBeDisabled();
    });

    await step('picking the other cluster resets to ITS first member', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /2 lessons/ }));
      await waitFor(() => expect(canvas.getByText('1 of 2')).toBeVisible());
      await expect(canvas.getByText('A lesson in the second cluster.')).toBeVisible();
    });
  },
};

export const OpensTheSelectedMemberAsALesson: Story = {
  render: () => {
    openLessonSpy.mockClear();
    return expanded(openLessonSpy);
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('opens the member the reader stepped to, by natural key', async () => {
      await waitFor(() => expect(canvas.getByText('1 of 3')).toBeVisible());
      await userEvent.click(canvas.getByRole('button', { name: 'Next lesson in this cluster' }));
      await waitFor(() => expect(canvas.getByText('2 of 3')).toBeVisible());
      await userEvent.click(canvas.getByRole('button', { name: 'Open lesson' }));
      await expect(openLessonSpy).toHaveBeenCalledWith({ scope: 'global', key: 'beta' });
    });
  },
};

export const SaysWhatItDoesNotKnow: Story = {
  parameters: {
    // A FULL candidate window, which is the state the footnote has to qualify.
    msw: { handlers: [...memoryHandlers(), handler({ candidates: 150 })] },
  },
  render: () => expanded(),
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
