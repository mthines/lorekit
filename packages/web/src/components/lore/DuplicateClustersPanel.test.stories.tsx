import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { DuplicateClustersPanel } from './DuplicateClustersPanel';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withFlagVariants } from '@/mocks/decorators';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * The FLAG gate on the Duplicate Clusters TRIGGER — `DuplicateClustersPanel` is
 * the copy-and-suffix resolver for `lore-explorer-duplicate-clusters`.
 *
 * These tests exist because the two gates on this surface are independent and it
 * matters that they compose in the right order:
 *
 *  1. **The flag** decides whether the trigger EXISTS. Off is the registry
 *     default, so this is the state `/lore` ships in.
 *  2. **`open`** decides whether an existing trigger's summary query FETCHES
 *     (`DuplicateClusters.test.stories.tsx` covers that half).
 *
 * The trap being guarded is a flagged-off surface that still costs something. So
 * the off-arm stories render with `open` seeded `true` — the state that WOULD
 * fetch — and then prove nothing rendered *and* nothing was requested. A gate
 * that only hides the DOM would pass a render-only assertion and fail this.
 *
 * The sidebar this trigger reveals has its own resolver
 * (`DuplicateClustersSidebarPanel`) and its own flag-gating coverage — not
 * duplicated here.
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

/** A controlled wrapper — `open` is `LoreExplorer`'s state in production. */
function ControlledPanel(props: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  return (
    <DuplicateClustersPanel
      scope="global"
      scopeLabel="global"
      open={open}
      onToggleOpen={() => setOpen((value) => !value)}
    />
  );
}

/** Seeded OPEN in the off-arm stories — so "did not fetch" can only be the flag. */
function panel(initialOpen = false) {
  clustersSeen.mockClear();
  return <ControlledPanel initialOpen={initialOpen} />;
}

export const FlagOffRendersNothingAndFetchesNothing: Story = {
  // No override — the registry default (`off`) is exactly what is under test.
  decorators: [withFlagVariants({})],
  render: () => panel(true),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the trigger is ABSENT entirely, not merely unclicked', async () => {
      await expect(canvas.queryByRole('button', { name: /duplicate clusters/i })).toBeNull();
      await expect(canvasElement.querySelector('button')).toBeNull();
    });

    await step('and nothing was requested, even with the disclosure seeded open', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(clustersSeen).not.toHaveBeenCalled();
    });
  },
};

export const FlagOnRendersTheTrigger: Story = {
  decorators: [withFlagVariants({ 'lore-explorer-duplicate-clusters': 'on' })],
  render: () => panel(false),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('collapsed: the trigger exists but fetches nothing yet', async () => {
      const toggle = await canvas.findByRole('button', { name: /duplicate clusters/i });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    await step('opening fetches — so the off-arm assertions are not vacuous', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /duplicate clusters/i }));
      await waitFor(() => expect(clustersSeen).toHaveBeenCalled());
      await waitFor(() =>
        expect(canvas.getByRole('button', { name: /duplicate clusters/i })).toHaveAttribute(
          'aria-expanded',
          'true',
        ),
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
  render: () => panel(true),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('button')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(clustersSeen).not.toHaveBeenCalled();
  },
};
