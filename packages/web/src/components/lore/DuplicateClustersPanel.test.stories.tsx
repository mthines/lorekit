import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { DuplicateClustersPanel } from './DuplicateClustersPanel';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withFlagVariants } from '@/mocks/decorators';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { writePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * The FLAG gate on the Duplicate Clusters panel — `DuplicateClustersPanel` is the
 * copy-and-suffix resolver for `lore-explorer-duplicate-clusters`.
 *
 * These tests exist because the two gates on this surface are independent and it
 * matters that they compose in the right order:
 *
 *  1. **The flag** decides whether the panel EXISTS. Off is the registry default,
 *     so this is the state `/lore` ships in.
 *  2. **The disclosure** decides whether an existing panel FETCHES
 *     (`DuplicateClusters.test.stories.tsx` covers that half).
 *
 * The trap being guarded is a flagged-off surface that still costs something. So
 * every story below seeds the disclosure OPEN — the state that WOULD fetch — and
 * the off-arm test then proves nothing rendered *and* nothing was requested. A
 * gate that only hides the DOM would pass a render-only assertion and fail this.
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

const meta: Meta<typeof DuplicateClustersPanel> = {
  title: 'Lore/DuplicateClustersPanel/Tests',
  component: DuplicateClustersPanel,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...memoryHandlers(), handler] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClustersPanel>;

/** Disclosure OPEN in every story — so "did not fetch" can only be the flag. */
function panel() {
  clustersSeen.mockClear();
  writePersistedPreference(PREFERENCE_KEYS.explorerClustersOpen, '1');
  return <DuplicateClustersPanel scope="global" scopeLabel="global" onOpenLesson={fn()} />;
}

export const FlagOffRendersNothingAndFetchesNothing: Story = {
  // No override — the registry default (`off`) is exactly what is under test.
  decorators: [withFlagVariants({})],
  render: panel,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the panel is ABSENT, not merely collapsed — no header, no toggle', async () => {
      await expect(canvas.queryByRole('button', { name: /duplicate clusters/i })).toBeNull();
      await expect(canvas.queryByRole('region', { name: 'Duplicate clusters' })).toBeNull();
      // Nothing mounted at all, rather than a hidden shell. Asserted against the
      // `<section>` the panel is built on — NOT `toHaveTextContent('')`, which
      // matches vacuously and would pass against the preview's injected
      // animation-reset `<style>` even if the panel HAD rendered.
      await expect(canvasElement.querySelector('section')).toBeNull();
    });

    await step('and nothing was requested, even with the disclosure seeded open', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });
  },
};

export const FlagOnRendersThePanel: Story = {
  decorators: [withFlagVariants({ 'lore-explorer-duplicate-clusters': 'on' })],
  render: panel,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the panel mounts and fetches — so the off-arm assertions are not vacuous', async () => {
      await waitFor(() => expect(clustersSeen).toHaveBeenCalled());
      await waitFor(() => expect(canvas.getByText('alpha')).toBeVisible());
      await expect(canvas.getByRole('button', { name: 'Hide duplicate clusters' })).toBeVisible();
    });

    await step('and it is the real panel, not a stub — the disclosure still works', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Hide duplicate clusters' }));
      await waitFor(() =>
        expect(canvas.getByRole('button', { name: 'Show duplicate clusters' })).toBeVisible(),
      );
    });
  },
};

/**
 * An unknown variant — a stale override cookie, or a variant renamed in the
 * registry — must fall to OFF, never render. `default` in the resolver's switch
 * is what makes that true, and it is easy to write as `default: on` by accident.
 */
export const UnknownVariantFallsToOff: Story = {
  decorators: [withFlagVariants({ 'lore-explorer-duplicate-clusters': 'experimental-arm' })],
  render: panel,
  play: async ({ canvasElement, step }) => {
    await step('renders nothing and requests nothing', async () => {
      await expect(canvasElement.querySelector('section')).toBeNull();
      await expect(
        within(canvasElement).queryByRole('button', { name: /duplicate clusters/i }),
      ).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });
  },
};
