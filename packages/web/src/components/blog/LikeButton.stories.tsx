import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { LikeButton } from './LikeButton';

/**
 * Visual-regression stories for {@link LikeButton} — the blog like control.
 * `Default` groups the states that change its look (untouched, warming toward
 * the cap, capped, and loading) into one snapshot; the press pop and particle
 * burst are click-driven and covered by the interaction tests instead.
 */
const meta: Meta<typeof LikeButton> = {
  title: 'Blog/LikeButton',
  component: LikeButton,
  parameters: { layout: 'centered' },
  args: { count: 1234, sessionLikes: 0, loading: false, onLike: fn() },
};

export default meta;
type Story = StoryObj<typeof LikeButton>;

export const Default: Story = {
  render: (args) => (
    <div className="flex flex-col items-center gap-10">
      <LikeButton {...args} sessionLikes={0} count={0} />
      <LikeButton {...args} sessionLikes={30} count={842} />
      <LikeButton {...args} sessionLikes={100} count={9800} />
      <LikeButton {...args} loading count={0} />
    </div>
  ),
};

export const Playground: Story = {
  args: { count: 512, sessionLikes: 12 },
  argTypes: {
    count: { control: { type: 'number' }, description: 'Global like total.' },
    sessionLikes: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
      description: "This session's contribution (drives warmth + the cap).",
    },
    loading: { control: 'boolean', description: 'Initial-count loading state.' },
  },
};
