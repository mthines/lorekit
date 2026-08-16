import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { RangePicker } from './RangePicker';
import type { RangePreset, TimeRange } from '@/lib/time-range';

/**
 * Interaction tests for {@link RangePicker}.
 *
 * The behaviour worth pinning is what `All` EMITS. It used to emit `null` —
 * which resolves to the same unbounded window as `{preset:'all'}`, so nothing
 * downstream could tell the two apart. That collapse is exactly what made the
 * Explorer unable to distinguish "the reader has not chosen a range yet" (an
 * absent `?range=`, which its Activity panel now renders as the last 24 hours)
 * from "the reader chose All time". Both still RESOLVE identically; only the
 * emitted value differs, which is why a screenshot cannot cover this and a
 * spied `onChange` can.
 */
const PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', 'all'];
const NOW = '2026-06-15T12:00:00.000Z';

/** Controlled, so a click moves the checked arm the way it does in production. */
function Harness({ initial, onChange }: { initial: TimeRange; onChange: (r: TimeRange) => void }) {
  const [value, setValue] = useState<TimeRange>(initial);
  return (
    <RangePicker
      value={value}
      presets={PRESETS}
      nowIso={NOW}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'UI/RangePicker/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'centered' },
  args: { initial: { preset: '24h' }, onChange: fn() },
};

export default meta;
type Story = StoryObj<typeof Harness>;

export const AllEmitsAnExplicitPreset: Story = {
  play: async ({ canvasElement, args, step }) => {
    const group = within(await within(canvasElement).findByRole('radiogroup', { name: /time range/i }));

    await step('picking a bounded preset emits that preset', async () => {
      await userEvent.click(group.getByRole('radio', { name: /last 7d/i }));
      await expect(args.onChange).toHaveBeenLastCalledWith({ preset: '7d' });
    });

    await step('picking All emits {preset:"all"}, NOT null', async () => {
      await userEvent.click(group.getByRole('radio', { name: /all time/i }));
      // The discriminating assertion. `null` would still render as All here and
      // still resolve to an unbounded window — it would just be indistinguishable
      // from a reader who never touched the control.
      await expect(args.onChange).toHaveBeenLastCalledWith({ preset: 'all' });
    });

    await step('and the control shows All as the checked arm', async () => {
      await expect(group.getByRole('radio', { name: /all time/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  },
};

/**
 * The other direction: a caller that still holds `null` (an untouched
 * `?range=`) must render as All rather than as an unset group — otherwise the
 * control would look broken on first load.
 */
export const NullStillRendersAsAllTime: Story = {
  args: { initial: null },
  play: async ({ canvasElement, step }) => {
    const group = within(await within(canvasElement).findByRole('radiogroup', { name: /time range/i }));

    await step('an unbounded value checks the All arm', async () => {
      await expect(group.getByRole('radio', { name: /all time/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    await step('and exactly one arm is checked', async () => {
      const checked = group
        .getAllByRole('radio')
        .filter((el) => el.getAttribute('aria-checked') === 'true');
      await expect(checked).toHaveLength(1);
    });
  },
};

/**
 * An absolute window matches no preset, so the control grows a checked, inert
 * "custom" arm instead of reporting the whole group unset.
 */
export const AbsoluteWindowGetsACustomArm: Story = {
  args: { initial: { from: '2026-06-10', to: '2026-06-12' } },
  play: async ({ canvasElement, step }) => {
    const group = within(await within(canvasElement).findByRole('radiogroup', { name: /time range/i }));

    await step('no preset is checked, but the group is not unset', async () => {
      const custom = group.getByRole('radio', { name: /custom range/i });
      await expect(custom).toHaveAttribute('aria-checked', 'true');
      await expect(custom).toHaveAttribute('aria-disabled', 'true');
    });

    await step('it is reachable by keyboard — it is the selected item', async () => {
      await expect(group.getByRole('radio', { name: /custom range/i })).toHaveAttribute(
        'tabindex',
        '0',
      );
    });
  },
};
