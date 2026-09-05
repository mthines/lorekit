import type { Meta, StoryObj } from '@storybook/react';
import { expect } from 'storybook/test';

import { LoreExplorerSkeleton } from './LoreExplorerSkeleton';

/**
 * Interaction tests for the Lore Explorer's loading placeholder.
 *
 * ## Why a structural test and not a visual baseline
 * A screenshot would be the natural fit for a placeholder, but every block here
 * carries Tailwind's `animate-pulse` — a CSS animation, which the preview's
 * `MotionConfig reducedMotion="always"` does not collapse (that governs
 * `motion/react` only). Pinning pixels would mean launching the browser context
 * with `reducedMotion: 'reduce'`, which would re-render every OTHER committed
 * baseline in the suite. So the invariant is asserted structurally instead.
 *
 * ## The invariant
 * The skeleton exists to resolve to the real layout with no jump, which makes it
 * a SECOND copy of that layout — one that no typecheck, and no test until now,
 * held to the first. It drifted exactly that way: the five retention conditions
 * moved into the filter menu, their separate trigger was deleted from the real
 * control row, and the skeleton kept drawing a block for it — so the placeholder
 * promised a control the loaded page did not have.
 */
const meta: Meta<typeof LoreExplorerSkeleton> = {
  title: 'Lore/LoreExplorerSkeleton/Tests',
  component: LoreExplorerSkeleton,
  tags: ['test'],
  parameters: { layout: 'fullscreen', chromatic: { disableSnapshot: true } },
};

export default meta;

/** The desktop and mobile control rows, in render order. */
function controlRows(canvasElement: HTMLElement): HTMLElement[] {
  // The skeleton is `aria-hidden` throughout — it is decorative until the data
  // arrives — so it is unreachable by role and is queried structurally.
  return Array.from(canvasElement.querySelectorAll<HTMLElement>('[data-testid="control-row"]'));
}

/**
 * The control row draws SEARCH + FILTER TRIGGER + DATE PILL, and nothing else.
 *
 * Three blocks, because `ControlRow` in `LoreExplorer.tsx` renders three
 * controls. A fourth is the regression this pins: it would push the date pill
 * sideways on first paint and then snap back once the real row rendered.
 */
export const ControlRowMirrorsTheRealOne: StoryObj<typeof LoreExplorerSkeleton> = {
  play: async ({ canvasElement, step }) => {
    await step('both breakpoints draw a control row', async () => {
      await expect(controlRows(canvasElement)).toHaveLength(2);
    });

    await step('each row is three blocks, not four', async () => {
      for (const row of controlRows(canvasElement)) {
        await expect(row.children).toHaveLength(3);
      }
    });

    await step('the search block is the one that grows', async () => {
      // The other two are `shrink-0` pills of fixed width; only the search box
      // takes the remaining space, exactly as the real row's input does.
      for (const row of controlRows(canvasElement)) {
        await expect(row.children[0]).toHaveClass('flex-1');
        await expect(row.children[1]).toHaveClass('shrink-0');
        await expect(row.children[2]).toHaveClass('shrink-0');
      }
    });

    await step('the filter trigger is wide on desktop and square on mobile', async () => {
      // Matching the real trigger, which reads "Filter" on desktop and collapses
      // to its icon (plus a count badge) on mobile.
      const [desktop, mobile] = controlRows(canvasElement);
      await expect(desktop!.children[1]).toHaveClass('w-20');
      await expect(mobile!.children[1]).toHaveClass('w-9');
    });
  },
};
