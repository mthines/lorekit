import type { Meta, StoryObj } from '@storybook/react';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { HealthSummary } from './HealthSummary';
import type { FailureRow } from '@/lib/usage-health';

/**
 * Visual-regression stories for {@link HealthSummary} — the at-a-glance
 * verdict banner atop Insights. Pure/presentational (no internal fetch), so
 * these pass realistic `rows`/`failures` directly.
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

function row(overrides: Partial<UsageStatRow> = {}): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'global',
    event_count: 1,
    record_count: 1,
    total_duration_ms: 100,
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
    rows: [row({ outcome: 'ok', event_count: 1_625 }), row({ outcome: 'error', event_count: 6 })],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
};

/** Between 95% and 99% success — the degraded (amber) verdict, with its top failure named. */
export const Degraded: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 1_920 }), row({ outcome: 'error', event_count: 80 })],
    previousRows: [],
    failures: [TOP_FAILURE],
    rangeCaption: 'the last 7 days',
  },
};

/** Below 95% success — the unhealthy (red) verdict. */
export const Unhealthy: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 325 }), row({ outcome: 'error', event_count: 175 })],
    previousRows: [],
    failures: [{ ...TOP_FAILURE, event_count: 175 }],
    rangeCaption: 'the last 7 days',
  },
};

/** A window with a preceding equal-length window to compare against — the trend chips render. */
export const WithTrend: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 1_150 }), row({ outcome: 'error', event_count: 6 })],
    previousRows: [row({ outcome: 'ok', event_count: 900 }), row({ outcome: 'error', event_count: 40 })],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
};

/** No calls in the window at all. */
export const NoCalls: Story = {
  args: {
    rows: [],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
};
