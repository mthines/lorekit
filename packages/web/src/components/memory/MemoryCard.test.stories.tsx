import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { MemoryCard, memoryFromLesson } from './MemoryCard';

/**
 * Interaction tests for the memory card's PR chip: a card recorded from a GitHub
 * PR (`origin_repo` + `origin_pr`) renders a real link straight to that PR, so
 * you can jump to it without opening the memory. `/Tests` namespace + test tag +
 * `chromatic.disableSnapshot` so these run their `play` functions without adding
 * a visual snapshot.
 */
const meta: Meta<typeof MemoryCard> = {
  title: 'Components/MemoryCard/Tests',
  component: MemoryCard,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof MemoryCard>;

const BASE = {
  scope: 'global',
  scope_type: 'global' as const,
  value: 'Branch a worktree from the stacked PR head, never main.',
  tags: ['loop::aw-lessons'],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

export const JumpsToPullRequest: Story = {
  args: {
    memory: memoryFromLesson({
      ...BASE,
      key: 'aw-lessons::worktree-isolation',
      origin_repo: 'mthines/lorekit',
      origin_pr: 482,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: /open pull request #482 on github/i });
    await expect(link).toHaveAttribute('href', 'https://github.com/mthines/lorekit/pull/482');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveTextContent('#482');
  },
};

export const NoChipWithoutPr: Story = {
  args: {
    memory: memoryFromLesson({
      ...BASE,
      key: 'aw-lessons::no-provenance',
      // No origin_repo / origin_pr — the chip must not appear.
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link', { name: /pull request/i })).toBeNull();
  },
};

/**
 * The chip forced the card root from a <button> to a <div> with a stretched
 * open-button behind a `pointer-events-none` body (an anchor may not nest in a
 * button). These two pin the halves of that restructure that the presence tests
 * above cannot see: the card still opens, and the chip does not open it.
 */
export const CardStillOpens: Story = {
  args: {
    memory: memoryFromLesson({
      ...BASE,
      key: 'aw-lessons::card-opens',
      origin_repo: 'mthines/lorekit',
      origin_pr: 482,
    }),
    onClick: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The body is pointer-events-none; the whole-card action is the stretched
    // button behind it, which is what a click anywhere on the card resolves to.
    await userEvent.click(canvas.getByRole('button', { name: /open memory/i }));
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const ChipClickDoesNotOpenMemory: Story = {
  args: {
    memory: memoryFromLesson({
      ...BASE,
      key: 'aw-lessons::chip-click',
      origin_repo: 'mthines/lorekit',
      origin_pr: 482,
    }),
    onClick: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The chip is a real link with target="_blank"; swallow the navigation so
    // the assertion is about the card's onClick, not about a popped-open tab.
    canvasElement.addEventListener(
      'click',
      (event) => {
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
      },
      true,
    );

    await userEvent.click(canvas.getByRole('link', { name: /open pull request #482 on github/i }));
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const NoChipWhenRepoButNoPr: Story = {
  args: {
    memory: memoryFromLesson({
      ...BASE,
      key: 'aw-lessons::repo-only',
      origin_repo: 'mthines/lorekit',
      // origin_pr absent — a repo alone is not enough for a PR link.
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link', { name: /pull request/i })).toBeNull();
  },
};
