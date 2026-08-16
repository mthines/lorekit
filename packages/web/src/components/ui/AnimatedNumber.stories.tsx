import type { Meta, StoryObj } from '@storybook/react';

import { AnimatedNumber } from './AnimatedNumber';

/**
 * Visual-regression stories for {@link AnimatedNumber}.
 *
 * The COUNT is not screenshotted, and cannot usefully be: a baseline of a
 * number mid-tween is a baseline of whenever the screenshot happened to land.
 * What these pin is the resting frame — that the counter renders exactly the
 * value it was given, at the caller's own type size, with no layout artefact
 * from the screen-reader sibling. The motion is covered by the interaction
 * tests in `AnimatedNumber.test.stories.tsx`, which sample real frames.
 *
 * `animateOnMount` is off by default, which is what makes that resting frame
 * deterministic here — see the prop's own note.
 */
const meta: Meta<typeof AnimatedNumber> = {
  title: 'UI/AnimatedNumber',
  component: AnimatedNumber,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof AnimatedNumber>;

/**
 * The sizes it is actually used at, together: a stat card's headline, the
 * Explorer strip's condensed figure, and the thousands separator the default
 * formatter applies (the reason a lifetime total stays readable).
 */
export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-4 bg-[var(--color-bg-raised)] p-6">
      <AnimatedNumber
        value={12}
        className="text-3xl font-bold tabular-nums text-[var(--color-content-primary)]"
      />
      <AnimatedNumber
        value={1247}
        className="text-2xl font-semibold tabular-nums text-[var(--color-content-primary)]"
      />
      <AnimatedNumber
        value={0}
        className="text-xl font-semibold tabular-nums text-[var(--color-content-tertiary)]"
      />
    </div>
  ),
};

export const Playground: Story = {
  args: {
    value: 1247,
    duration: 0.4,
    animateOnMount: false,
    className: 'text-3xl font-bold tabular-nums text-[var(--color-content-primary)]',
  },
  argTypes: {
    value: { control: 'number' },
    duration: { control: { type: 'range', min: 0.1, max: 2, step: 0.05 } },
    animateOnMount: { control: 'boolean' },
    className: { control: 'text' },
  },
};
