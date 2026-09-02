import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { HealthSummary } from './HealthSummary';
import type { FailureRow } from '@/lib/usage-health';

/**
 * Interaction tests for {@link HealthSummary} — asserts the verdict/percentage
 * math sums ALL of `rows` (not just `failures`), the top failure's context
 * renders when one exists, a clean window omits it entirely, and the trend
 * chip appears only when there is a non-empty `previousRows` to compare against.
 */
const meta: Meta<typeof HealthSummary> = {
  title: 'Dashboard/HealthSummary/Tests',
  component: HealthSummary,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
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

export const HealthyWindowShowsNoFailureLine: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 200 })],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('renders the healthy verdict and the exact success percentage', async () => {
      await expect(canvas.getByText('Healthy')).toBeVisible();
      await expect(canvas.getByText('100% of calls succeeded')).toBeVisible();
    });
    await step('no failure line renders when nothing failed', async () => {
      await expect(canvas.queryByText(/Most common issue/)).not.toBeInTheDocument();
    });
    await step('no trend chip renders when there is no previous window', async () => {
      await expect(canvas.queryByText(/pp\)/)).not.toBeInTheDocument();
    });
  },
};

const TOP_FAILURE: FailureRow = {
  tool_name: 'memory.read',
  outcome: 'error',
  event_count: 187,
  topContext: { client: 'cli', scope_type: 'branch', event_count: 150 },
};

export const DegradedWindowNamesTheTopFailure: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 960 }), row({ outcome: 'error', event_count: 40 })],
    previousRows: [],
    failures: [TOP_FAILURE],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the verdict badge reads Degraded between the 95%/99% thresholds', async () => {
      await expect(canvas.getByText('Degraded')).toBeVisible();
      await expect(canvas.getByText('96% of calls succeeded')).toBeVisible();
    });
    await step('the top failure names its tool and dominant context, not just a count', async () => {
      await expect(canvas.getByText(/memory\.read/)).toBeVisible();
      await expect(canvas.getByText(/mostly cli · branch/)).toBeVisible();
    });
  },
};

export const UnhealthyWindowSumsAllRowsNotJustFailures: Story = {
  args: {
    // `failures` alone sums to 300 events — far short of `rows`' 500 total —
    // so a regression that summed `failures` instead of `rows` would read a
    // different (higher) percentage than the correct 40%.
    rows: [row({ outcome: 'ok', event_count: 200 }), row({ outcome: 'error', event_count: 300 })],
    previousRows: [],
    failures: [{ ...TOP_FAILURE, event_count: 300 }],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the percentage sums every row, not a re-sum of failures alone', async () => {
      await expect(canvas.getByText('Unhealthy')).toBeVisible();
      await expect(canvas.getByText('40% of calls succeeded')).toBeVisible();
    });
  },
};

export const TrendChipsCompareAgainstThePreviousWindow: Story = {
  args: {
    rows: [row({ outcome: 'ok', event_count: 190 }), row({ outcome: 'error', event_count: 10 })],
    previousRows: [row({ outcome: 'ok', event_count: 90 }), row({ outcome: 'error', event_count: 10 })],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('call volume and success-rate trend chips render against the previous window', async () => {
      await expect(canvas.getByText('95% of calls succeeded')).toBeVisible();
      await expect(canvas.getByText(/\+5pp/)).toBeVisible();
      await expect(canvas.getByText(/\+100%/)).toBeVisible();
    });
  },
};

export const NoCallsRendersTheEmptyMessage: Story = {
  args: {
    rows: [],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty window renders the no-calls message, not a 100% verdict banner', async () => {
      await expect(canvas.getByText(/No calls recorded/)).toBeVisible();
      await expect(canvas.queryByText('Healthy')).not.toBeInTheDocument();
    });
  },
};
