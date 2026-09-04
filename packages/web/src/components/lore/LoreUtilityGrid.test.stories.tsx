import type { Meta, StoryObj } from '@storybook/react';
import { expect, within, userEvent, waitFor, fn } from 'storybook/test';

import { LoreUtilityGrid } from './LoreUtilityGrid';
import { memoryHandlers, utilityHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link LoreUtilityGrid} — the counts, the quadrant
 * drill-down, the `counting_since` qualifier (never the bare word "never"),
 * and the groom clipboard handoff.
 */
const meta: Meta<typeof LoreUtilityGrid> = {
  title: 'Lore/LoreUtilityGrid/Tests',
  component: LoreUtilityGrid,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...utilityHandlers(), ...memoryHandlers()] },
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof LoreUtilityGrid>;

export const ShowsAllFiveStatesIncludingTooNewToJudge: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the four quadrants render with their action verbs', async () => {
      await waitFor(() => expect(canvas.getByText('Load-bearing')).toBeVisible());
      for (const action of ['→ Promote to a rule', '→ Broaden its scope', '→ Prune first', '→ Archive']) {
        await expect(canvas.getByText(action)).toBeVisible();
      }
    });
    await step('the FIFTH state is present — the whole point of the surface', async () => {
      // Without it a lesson written yesterday and one dead for a year render
      // identically, which is the confusion this grid exists to remove.
      await expect(canvas.getByText('Too new to judge')).toBeVisible();
      // Two fixture rows sit there: one too young, one too thinly delivered.
      const strip = canvas.getByRole('button', { name: /too new to judge/i });
      await expect(within(strip).getByText('2')).toBeVisible();
    });
    await step('a 0 is qualified by the counting_since date, never called "never"', async () => {
      await expect(canvas.getByText(/counting began/i)).toBeVisible();
      await expect(canvas.queryByText(/^never$/i)).not.toBeInTheDocument();
    });
  },
};

export const NoRowsAreFetchedUntilAQuadrantIsPicked: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Noise tax')).toBeVisible());
    await step('the census alone renders — no row list, and no request for one', async () => {
      // `useLoreUtilityRows` is `enabled` on a selection, the same posture the
      // Explorer's clusters sidebar takes: a surface nobody opened costs
      // nothing. A row rendered here would mean the query ran unasked.
      await expect(canvas.queryByText('legacy-formatting-rule')).not.toBeInTheDocument();
    });
    await step('picking Noise tax swaps in exactly that quadrant', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /noise tax/i }));
      await waitFor(() => expect(canvas.getByText('legacy-formatting-rule')).toBeVisible());
      // Not the whole store: a load-bearing lesson must NOT appear under a
      // heading that tells the reader to prune what is listed.
      await expect(canvas.queryByText('never-run-nx-fanouts-in-a-sandbox')).not.toBeInTheDocument();
    });
    await step('picking it again clears the selection', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /noise tax/i }));
      await waitFor(() => expect(canvas.queryByText('legacy-formatting-rule')).not.toBeInTheDocument());
    });
  },
};

export const EachRowDeepLinksIntoTheExplorer: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Dormant')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: /dormant/i }));
    await step('the row is a link to the Explorer narrowed to that scope and key', async () => {
      // Acting on a quadrant means reading the lesson first; an inert row makes
      // that a manual re-search on another page.
      const link = await canvas.findByRole('link', { name: /never-used-fallback-branch/ });
      await expect(link).toHaveAttribute(
        'href',
        '/lore?scope=branch%3A%3Aacme%2Fapp%3A%3Afeat%2Fold&q=never-used-fallback-branch',
      );
    });
  },
};

export const CopyForGroomCopiesTheSelectedQuadrantOnly: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Noise tax')).toBeVisible());
    const writeText = fn().mockResolvedValue(undefined);
    // `navigator.clipboard` is a getter-only accessor in a real browser (this
    // suite runs in actual Chromium via Playwright, not jsdom), so a plain
    // `Object.assign` throws — redefine the property instead.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await step('the handoff carries THIS quadrant\'s scope::key lines and nothing else', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /noise tax/i }));
      await waitFor(() => expect(canvas.getByText('legacy-formatting-rule')).toBeVisible());
      await userEvent.click(canvas.getByRole('button', { name: /copy for groom/i }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('global::legacy-formatting-rule'));
      await expect(canvas.getByRole('button', { name: /copied/i })).toBeVisible();
    });
  },
};
