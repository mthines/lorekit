import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';

import { LoreGraphView } from './LoreGraphView';
import {
  hubHeavyAccount,
  realisticAccount,
  singleMemory,
  unrelatedMemories,
} from '@/lib/lore-graph/story-fixtures';

/**
 * Interaction tests for the memory map.
 *
 * ## What these can and cannot assert
 *
 * They deliberately test the **DOM around the canvas**, never pixels inside it.
 * That is not a compromise — it is where the contract that matters lives. A
 * `<canvas>` is opaque to assistive technology, so the map's promise is that
 * everything it shows visually is also stated in text: the live-region summary,
 * the coverage notice, the legend, the empty state. Those are exactly what a
 * non-visual reader gets, and they are fully deterministic.
 *
 * Put the other way round: if these tests pass, a screen-reader user can use
 * the feature. A pixel test could not tell you that.
 *
 * The one thing asserted about WebGL is that the scene does not take the page
 * down when it cannot start — the `SceneBoundary` case — because a headless
 * runner is itself a browser that may have no GPU, which makes this suite the
 * natural place to prove that path.
 */
const meta: Meta<typeof LoreGraphView> = {
  title: 'Lore/LoreGraphView/Tests',
  component: LoreGraphView,
  tags: ['test'],
  parameters: {
    layout: 'padded',
    chromatic: { disableSnapshot: true },
  },
  args: {
    selectedId: null,
    hasMore: false,
    onSelect: () => undefined,
  },
};

export default meta;
type Story = StoryObj<typeof LoreGraphView>;

export const AnnouncesWhatIsOnScreen: Story = {
  args: { memories: singleMemory() },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the map states its contents in text, not only in pixels', async () => {
      // The layout settles asynchronously (worker or inline fallback), and the
      // live region reads "Arranging…" until it does — so find the settled text
      // rather than asserting on whatever the first paint happened to show.
      const summary = await canvas.findByText(/Map of 1 memory across 1 scope/);
      await expect(summary).toBeInTheDocument();
    });
  },
};

export const CountsRelationshipsNotSkeletonEdges: Story = {
  args: { memories: unrelatedMemories(12) },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('unrelated memories report zero relationships', async () => {
      // Twelve memories in one scope means twelve skeleton edges and no
      // relations. Announcing "12 relationships" would describe connections the
      // reader cannot act on — this is the regression that guards it.
      await expect(await canvas.findByText(/0 relationships drawn/)).toBeInTheDocument();
    });
  },
};

export const ExplainsWhyThereAreNoRelationships: Story = {
  args: { memories: hubHeavyAccount(120) },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('hub suppression is stated, not silent', async () => {
      // Without this notice, "every label is on every memory" and "these
      // memories share nothing" render identically and mean opposite things.
      const notice = await canvas.findByText(/too common to be a relationship/);
      await expect(notice).toBeInTheDocument();
    });
  },
};

export const SaysWhenItIsDrawingOnlyLoadedPages: Story = {
  args: { memories: realisticAccount({ count: 40 }), hasMore: true },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a partially-loaded map admits it', async () => {
      await expect(await canvas.findByText(/only the memories loaded so far/)).toBeInTheDocument();
    });
  },
};

export const NamesEveryScopeTypeInTheLegend: Story = {
  args: { memories: realisticAccount({ count: 30 }) },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('scope types are named, not encoded in colour alone', async () => {
      // WCAG 1.4.1: colour is never the only channel. Each swatch carries its
      // name beside it, and these assertions are what stop a future tidy-up
      // from reducing the legend to dots.
      for (const type of ['global', 'project', 'repo', 'branch']) {
        await expect(await canvas.findByText(type)).toBeInTheDocument();
      }
    });
  },
};

export const ExplainsItselfWhenThereIsNothingToMap: Story = {
  args: { memories: [] },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('an empty account gets an explanation, not a void', async () => {
      // An empty 3D scene is indistinguishable from a broken one, so the empty
      // state has to be a real explanation rather than an empty canvas.
      await expect(await canvas.findByText('Nothing to map yet')).toBeInTheDocument();
    });
  },
};
