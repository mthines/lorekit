import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';

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
