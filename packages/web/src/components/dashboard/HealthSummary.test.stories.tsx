import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import type { UsageSummary } from '@lorekit/schemas/usage';
import { HealthSummary } from './HealthSummary';
import type { FailureRow } from '@/lib/usage-health';

/**
 * Interaction tests for {@link HealthSummary} — asserts the verdict/percentage
 * math reads from `summary` (not a re-sum of `failures`), the top failure's
 * context renders when one exists, and a clean window omits it entirely.
 */
const meta: Meta<typeof HealthSummary> = {
  title: 'Dashboard/HealthSummary/Tests',
  component: HealthSummary,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
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

export const HealthyWindowShowsNoFailureLine: Story = {
  args: {
    summary: summary({ total_events: 200, by_outcome: { ok: 200 } }),
    failures: [],
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
    summary: summary({ total_events: 1_000, by_outcome: { ok: 960, error: 40 } }),
    failures: [TOP_FAILURE],
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

export const UnhealthyWindowReadsFromSummaryNotFailures: Story = {
  args: {
    // total_events/by_outcome deliberately imply a much lower success rate than
    // failures alone would sum to, so a re-derivation bug (summing `failures`
    // instead of reading `summary.by_outcome`) would read a different number.
    summary: summary({ total_events: 500, by_outcome: { ok: 200, error: 300 } }),
    failures: [{ ...TOP_FAILURE, event_count: 300 }],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the percentage comes from summary.by_outcome, not a re-sum of failures', async () => {
      await expect(canvas.getByText('Unhealthy')).toBeVisible();
      await expect(canvas.getByText('40% of calls succeeded')).toBeVisible();
    });
  },
};

export const NoCallsRendersTheEmptyMessage: Story = {
  args: {
    summary: summary({ total_events: 0, by_outcome: {} }),
    failures: [],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('an empty window renders the no-calls message, not a 100% verdict banner', async () => {
      await expect(canvas.getByText(/No calls recorded/)).toBeVisible();
      await expect(canvas.queryByText('Healthy')).not.toBeInTheDocument();
    });
  },
};
