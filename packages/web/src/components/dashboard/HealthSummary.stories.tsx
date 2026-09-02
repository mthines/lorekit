import type { Meta, StoryObj } from '@storybook/react';
import type { UsageSummary } from '@lorekit/schemas/usage';
import { HealthSummary } from './HealthSummary';
import type { FailureRow } from '@/lib/usage-health';

/**
 * Visual-regression stories for {@link HealthSummary} — the at-a-glance
 * verdict banner atop Insights. Pure/presentational (no internal fetch), so
 * these pass realistic `summary`/`failures` directly.
 */
const meta: Meta<typeof HealthSummary> = {
  title: 'Dashboard/HealthSummary',
  component: HealthSummary,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '48rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof HealthSummary>;

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    total_events: 0,
    reads: 0,
    writes: 0,
    other: 0,
    records_read: 0,
    archived: 0,
    expired: 0,
    by_outcome: {},
    ...overrides,
  };
}

const TOP_FAILURE: FailureRow = {
  tool_name: 'memory.read',
  outcome: 'error',
  event_count: 187,
  topContext: { client: 'cli', scope_type: 'branch', event_count: 150 },
};

/** ≥99% success — the healthy verdict, no failure line. */
export const Healthy: Story = {
  args: {
    summary: summary({ total_events: 1_631, by_outcome: { ok: 1_625, error: 6 } }),
    failures: [],
  },
};

/** Between 95% and 99% success — the degraded (amber) verdict, with its top failure named. */
export const Degraded: Story = {
  args: {
    summary: summary({ total_events: 2_000, by_outcome: { ok: 1_920, error: 80 } }),
    failures: [TOP_FAILURE],
  },
};

/** Below 95% success — the unhealthy (red) verdict. */
export const Unhealthy: Story = {
  args: {
    summary: summary({ total_events: 500, by_outcome: { ok: 325, error: 175 } }),
    failures: [{ ...TOP_FAILURE, event_count: 175 }],
  },
};

/** No calls in the window at all. */
export const NoCalls: Story = {
  args: {
    summary: summary({ total_events: 0, by_outcome: {} }),
    failures: [],
  },
};
