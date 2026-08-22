import type { Meta, StoryObj } from '@storybook/react';
import { BarChart3, CalendarDays } from 'lucide-react';
import { useState } from 'react';

import { SEGMENTED_TRAILING_CLASS, SegmentedControl } from './SegmentedControl';

/**
 * Visual-regression stories for the shared segmented control.
 *
 * This look used to be private to `RangePicker`. It has its own baseline now
 * because two callers depend on it, so a change to the rail, the segment sizing
 * or the lifted active segment moves both — and the point of extracting it was
 * that such a change lands once and is reviewed once.
 *
 * One screenshot covers every rendering the primitive has: text-only (the range
 * picker's shape), icon-and-text (the Activity view toggle's), a group with
 * nothing selected plus its trailing out-of-set arm (the custom-window case), and
 * an icon-only group (what the toggle collapses to at a narrow container width).
 */
const meta: Meta<typeof SegmentedControl> = {
  title: 'UI/SegmentedControl',
  component: SegmentedControl,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof SegmentedControl>;

const PRESETS = [
  { value: '24h', label: '24h', ariaLabel: 'Last 24h' },
  { value: '7d', label: '7d', ariaLabel: 'Last 7d' },
  { value: '30d', label: '30d', ariaLabel: 'Last 30d' },
  { value: 'all', label: 'All', ariaLabel: 'All time' },
] as const;

const VIEWS = [
  { value: 'charts', label: 'Stat charts', icon: BarChart3, ariaLabel: 'Show stat charts' },
  { value: 'heatmap', label: 'Heatmap', icon: CalendarDays, ariaLabel: 'Show the write heatmap' },
] as const;

export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1rem' }}>
      {/* Text-only, mid-group selection — the range picker's shape. */}
      <SegmentedControl
        label="Time range"
        items={PRESETS}
        value="7d"
        onChange={() => undefined}
      />

      {/* Icon + text — the Activity view toggle's shape. */}
      <SegmentedControl label="Activity view" items={VIEWS} value="charts" onChange={() => undefined} />

      {/* Nothing in the closed set is selected, and a trailing arm stands in for
          the value that cannot be expressed — the custom-window case. Without the
          arm the whole group would read as unset. */}
      <SegmentedControl
        label="Time range with a custom window"
        items={PRESETS}
        value={null}
        onChange={() => undefined}
        trailing={
          <span className={SEGMENTED_TRAILING_CLASS}>Jun 10 – Jun 12</span>
        }
      />

      {/* Icon-only: what `labels="wide"` collapses to below the `@md` container
          width. Forced here by giving the container less than that, since the
          collapse is a container query rather than a viewport one. */}
      <div className="@container" style={{ width: '12rem' }}>
        {/* `w-fit` because a bare block container would stretch the rail; in the
            real header it is a flex item and sizes to its segments. */}
        <SegmentedControl
          label="Activity view, narrow"
          items={VIEWS}
          value="heatmap"
          onChange={() => undefined}
          labels="wide"
          className="w-fit"
        />
      </div>
    </div>
  ),
};

/**
 * Interactive, so the control can be clicked in the Storybook UI. Keeps the
 * `StoryObj<typeof SegmentedControl>` type so a prop rename breaks this file at
 * compile time.
 */
export const Playground: Story = {
  render: function Interactive() {
    const [value, setValue] = useState<'charts' | 'heatmap'>('charts');
    return (
      <SegmentedControl label="Activity view" items={VIEWS} value={value} onChange={setValue} />
    );
  },
};
