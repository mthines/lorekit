import type { Meta, StoryObj } from '@storybook/react';

import { BlogPostCard } from './BlogPostCard';
import type { PostMeta } from '@/lib/blog/content';

const POST: PostMeta = {
  slug: 'self-healing-agents',
  title: 'Self-healing agents are just a loop you forgot to build',
  description:
    "Self-healing and self-improving agents sound like an ML problem. They're not. It's a plain read-fail-write loop over shared memory — no fine-tuning, no new model call.",
  date: '2026-08-01',
  author: 'Mads Thines',
  readingMinutes: 8,
  tags: ['self-healing', 'self-improving', 'agents'],
  order: 1,
  keywords: [],
};

const meta: Meta<typeof BlogPostCard> = {
  title: 'Blog/BlogPostCard',
  component: BlogPostCard,
  parameters: { layout: 'padded', nextjs: { appDirectory: true } },
  args: { post: POST },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '40rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BlogPostCard>;

/** Visual-regression story: the card as it appears on the `/blog` index. */
export const Default: Story = {};

// Keeps the `StoryObj<typeof BlogPostCard>` type so a `PostMeta` change breaks
// this file at compile time.
export const Playground: Story = {
  args: {
    post: { ...POST, tags: ['memory', 'mcp', 'hooks', 'scopes'], readingMinutes: 12 },
  },
  argTypes: {
    post: { control: 'object', description: 'Post metadata rendered on the card.' },
  },
};
