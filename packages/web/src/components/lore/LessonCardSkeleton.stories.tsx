import type { Meta, StoryObj } from '@storybook/react';
import { expect } from 'storybook/test';

import { LessonCardSkeleton } from './LessonCardSkeleton';

/**
 * `LessonCardSkeleton` mirrors the real `MemoryCard` (`layout="card"`)
 * structurally so the list does not visually jump when data arrives.
 *
 * ## Why a structural assertion and not a pixel baseline
 * Every block here carries Tailwind's `animate-pulse` — a CSS keyframe
 * animation, which the preview's `MotionConfig reducedMotion="always"` does
 * not collapse (that governs `motion/react` only, see
 * `LoreExplorerSkeleton.test.stories.tsx`). A `toMatchScreenshot` baseline
 * would then be pinned to whatever opacity the pulse happened to be at when
 * the screenshot fired — non-deterministic across runs — so `Default` opts
 * out of Chromatic/visual-regression snapshotting and the shape is instead
 * pinned by a structural interaction test, same convention as the sibling
 * `LoreExplorerSkeleton`.
 */
const meta: Meta<typeof LessonCardSkeleton> = {
  title: 'Lore/LessonCardSkeleton',
  component: LessonCardSkeleton,
  parameters: { layout: 'padded', chromatic: { disableSnapshot: true } },
};

export default meta;
type Story = StoryObj<typeof LessonCardSkeleton>;

/** A single card placeholder, as it renders inline in the memory list. */
export const Default: Story = {
  play: async ({ canvasElement, step }) => {
    await step('mirrors the real card: header row, preview, chip row', async () => {
      const root = canvasElement.querySelector('[aria-hidden="true"]');
      await expect(root).toBeTruthy();
      // Root shape matches MemoryCard's card wrapper exactly.
      await expect(root).toHaveClass('rounded-xl');
      await expect(root).toHaveClass('flex-col');
      // Three sections: header row, preview block, chip row.
      await expect(root!.children).toHaveLength(3);
    });

    await step('the header row has a scope badge, org chip, title, and a trailing timestamp', async () => {
      const header = canvasElement.querySelector('[aria-hidden="true"] > div');
      await expect(header!.children).toHaveLength(4);
      // The timestamp block is pushed to the far end, like the real card's.
      await expect(header!.children[3]).toHaveClass('ml-auto');
    });

    await step('the preview block is two lines', async () => {
      const preview = canvasElement.querySelectorAll('[aria-hidden="true"] > div')[1];
      await expect(preview.children).toHaveLength(2);
    });
  },
};

/** Several placeholders stacked, as they render while a page is loading. */
export const ListOfFive: Story = {
  parameters: { chromatic: { disableSnapshot: true } },
  render: () => (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading memories">
      {[0, 1, 2, 3, 4].map((i) => (
        <LessonCardSkeleton key={i} />
      ))}
    </div>
  ),
};
