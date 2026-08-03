import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { LikeButton } from './LikeButton';
import { clampSessionLikes } from '@/lib/blog/likes';

/**
 * Interaction tests for {@link LikeButton}. It is a controlled component, so a
 * tiny stateful harness stands in for `PostLikes`: it increments both the global
 * count and this session's contribution on each accepted press, which is exactly
 * the contract the real container fulfils optimistically.
 *
 * The assertions stay on deterministic state (the visible count, the caption,
 * and the capped/disabled transition) — never on the particle burst, which is
 * click-driven motion and not a correctness property.
 */

function Harness({
  initialCount,
  initialSession,
  onLike,
}: {
  initialCount: number;
  initialSession: number;
  onLike: () => void;
}) {
  const [count, setCount] = useState(initialCount);
  const [session, setSession] = useState(initialSession);
  return (
    <LikeButton
      count={count}
      sessionLikes={session}
      onLike={() => {
        onLike();
        setCount((c) => c + 1);
        setSession((s) => clampSessionLikes(s + 1));
      }}
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Blog/LikeButton/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof Harness>;

export const PressIncrementsAndReports: Story = {
  args: { initialCount: 41, initialSession: 0, onLike: fn() },
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button');

    await step('a press reports the like and bumps the total', async () => {
      await userEvent.click(button);
      await expect(args.onLike).toHaveBeenCalledTimes(1);
      await expect(canvas.getByText('42')).toBeInTheDocument();
    });

    await step('the caption reflects this session\'s contribution', async () => {
      await expect(canvas.getByText('You\'ve liked this 1 time.')).toBeInTheDocument();
    });
  },
};

export const CapsAtTheSessionMax: Story = {
  args: { initialCount: 900, initialSession: 99, onLike: fn() },
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button');

    await step('the 100th like is accepted', async () => {
      await userEvent.click(button);
      await expect(args.onLike).toHaveBeenCalledTimes(1);
      await expect(canvas.getByText('901')).toBeInTheDocument();
    });

    await step('the button then disables and announces the cap', async () => {
      await expect(button).toBeDisabled();
      await expect(canvas.getByText(/thank you/i)).toBeInTheDocument();
      await expect(canvas.getByRole('status')).toHaveTextContent('Maximum of 100 likes reached.');
    });

    await step('a further press does nothing', async () => {
      await userEvent.click(button, { pointerEventsCheck: 0 });
      await expect(args.onLike).toHaveBeenCalledTimes(1);
    });
  },
};
