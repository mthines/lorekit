import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';

import { BlogPostCard } from './BlogPostCard';
import type { PostMeta } from '@/lib/blog/content';

/**
 * Interaction tests for {@link BlogPostCard} — `/Tests` namespace, `test`-tagged,
 * `chromatic.disableSnapshot` so the visual-regression `afterEach` skips them.
 * Assert the card is a single link to the post, with the title, meta, and tags
 * a reader scans before clicking.
 */

const POST: PostMeta = {
  slug: 'self-healing-agents',
  title: 'Self-healing agents are just a loop you forgot to build',
  description: 'A plain read-fail-write loop over shared memory.',
  date: '2026-08-01',
  author: 'Mads Thines',
  readingMinutes: 8,
  tags: ['self-healing', 'self-improving', 'agents'],
  order: 1,
  keywords: [],
};

const meta: Meta<typeof BlogPostCard> = {
  title: 'Blog/BlogPostCard/Tests',
  component: BlogPostCard,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    nextjs: { appDirectory: true },
  },
  args: { post: POST },
};

export default meta;
type Story = StoryObj<typeof BlogPostCard>;

export const LinksToThePostWithScannableMeta: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the whole card is one link to the post', async () => {
      const link = await canvas.findByRole('link');
      await expect(link).toHaveAttribute('href', '/blog/self-healing-agents');
    });

    await step('title, reading time, and formatted date are shown', async () => {
      await expect(canvas.getByText(POST.title)).toBeVisible();
      await expect(canvas.getByText('8 min read')).toBeVisible();
      await expect(canvas.getByText('August 1, 2026')).toBeVisible();
    });

    await step('tags are listed for scanning', async () => {
      for (const tag of POST.tags) {
        await expect(canvas.getByText(tag)).toBeVisible();
      }
    });
  },
};
