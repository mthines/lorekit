import type { Meta, StoryObj } from '@storybook/react';

import { StatusControl } from './StatusControl';
import { MEMORY_STATUSES } from '@/lib/status-filter';

/**
 * Visual-regression stories for the Explorer's Status control.
 *
 * These fix the resting states — every selection, at both widths. The
 * behaviour (which query params a selection maps to, and that the choice
 * survives a reload) is exercised by `StatusControl.test.stories.tsx` and by
 * `lib/status-filter.spec.ts`, the same split the filter surface uses.
 */
const meta: Meta<typeof StatusControl> = {
  title: 'Lore/StatusControl',
  component: StatusControl,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof StatusControl>;

const noop = () => undefined;

/**
 * The trigger in each state, labelled then icon-only.
 *
 * All three are rendered together rather than as three stories because what is
 * worth eyeballing is that the trigger stays the SAME SHAPE as its label
 * changes length — "Active" and "Expiring" must not resize the toolbar around
 * them, which a single screenshot per state could not show.
 *
 * The open list is not screenshotted: it is portaled and positioned from the
 * trigger's measured rect, so a baseline would pin wherever the trigger
 * happened to land in this story. `Combobox.test.stories.tsx` covers it.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {(['desktop', 'mobile'] as const).map((variant) => (
        <div key={variant} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {variant}
          </span>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {MEMORY_STATUSES.map((status) => (
              <StatusControl key={status} value={status} onChange={noop} variant={variant} />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
