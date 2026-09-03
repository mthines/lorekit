import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { HealthSummary } from './HealthSummary';
import type { FailureRow } from '@/lib/usage-health';

/**
 * Interaction tests for {@link HealthSummary} — asserts the verdict/percentage
 * math sums ALL of `rows` (not just `failures`), that the verdict weighs
 * coverage as well as reliability and names whichever drove it, that the top
 * failure's context renders when one exists, and that the trend chips appear
 * only against a previous window big enough to compare with.
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
    rows: [row({ outcome: 'ok', event_count: 200, record_count: 400 })],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('renders the healthy verdict, named for the dimension that drove it', async () => {
      await expect(canvas.getByText('Healthy')).toBeVisible();
      await expect(canvas.getByText('Agent calls are succeeding')).toBeVisible();
    });
    await step('both dimensions render as figures, not just the driver', async () => {
      await expect(canvas.getByText('100%')).toBeVisible();
      await expect(canvas.getByText('2.0')).toBeVisible();
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
    rows: [
      row({ outcome: 'ok', event_count: 960, record_count: 1000 }),
      row({ outcome: 'error', event_count: 40, record_count: 0 }),
    ],
    previousRows: [],
    failures: [TOP_FAILURE],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the verdict badge reads Degraded between the 95%/99% thresholds', async () => {
      await expect(canvas.getByText('Degraded')).toBeVisible();
      await expect(canvas.getByText('Some agent calls are failing')).toBeVisible();
      await expect(canvas.getByText('96%')).toBeVisible();
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
    rows: [
      row({ outcome: 'ok', event_count: 200, record_count: 600 }),
      row({ outcome: 'error', event_count: 300, record_count: 0 }),
    ],
    previousRows: [],
    failures: [{ ...TOP_FAILURE, event_count: 300 }],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the percentage sums every row, not a re-sum of failures alone', async () => {
      await expect(canvas.getByText('Unhealthy')).toBeVisible();
      await expect(canvas.getByText('40%')).toBeVisible();
    });
  },
};

export const PerfectlyReliableButEmptyReadsStillReadsUnhealthy: Story = {
  args: {
    // The case reliability-only could not express: every call returned 200, and
    // the agents found almost nothing. `outcome` has no "found nothing" value,
    // so this window is 100% `ok` — and is exactly the problem a reader opened
    // the page to discover.
    rows: [row({ tool_name: 'memory.search', outcome: 'ok', event_count: 1176, record_count: 15 })],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('coverage drives the verdict and the headline says so', async () => {
      await expect(canvas.getByText('Unhealthy')).toBeVisible();
      await expect(canvas.getByText('Agents are asking for lore and mostly finding none')).toBeVisible();
    });
    await step('the reliability figure still renders, so the red badge is explained not contradicted', async () => {
      await expect(canvas.getByText('100%')).toBeVisible();
      await expect(canvas.getByText('0.0')).toBeVisible();
      await expect(canvas.getByText('(15 found in 1,176 reads)')).toBeVisible();
    });
  },
};

export const WriteOnlyWindowReportsNoReadsRatherThanZero: Story = {
  args: {
    // A write-heavy window has no coverage to report. Folding `memory.write`'s
    // structural `record_count: 0` into the ratio would render it as a total
    // coverage failure instead of an absence.
    rows: [row({ tool_name: 'memory.write', outcome: 'ok', event_count: 500, record_count: 0 })],
    previousRows: [],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('reliability drives the verdict and coverage reads as absent', async () => {
      await expect(canvas.getByText('Healthy')).toBeVisible();
      await expect(canvas.getByText('Agent calls are succeeding')).toBeVisible();
      await expect(canvas.getByText('no reads')).toBeVisible();
    });
  },
};

export const TrendChipsCompareAgainstThePreviousWindow: Story = {
  args: {
    rows: [
      row({ outcome: 'ok', event_count: 190, record_count: 400 }),
      row({ outcome: 'error', event_count: 10, record_count: 0 }),
    ],
    previousRows: [
      row({ outcome: 'ok', event_count: 90, record_count: 200 }),
      row({ outcome: 'error', event_count: 10, record_count: 0 }),
    ],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('call volume and success-rate trend chips render against the previous window', async () => {
      await expect(canvas.getByText('95%')).toBeVisible();
      await expect(canvas.getByText(/\+5pp/)).toBeVisible();
      await expect(canvas.getByText(/\+100%/)).toBeVisible();
    });
  },
};

export const TooSmallAPreviousWindowSuppressesTheTrend: Story = {
  args: {
    // A single prior call would render "+19,900%" — arithmetically right, pure
    // noise. `MIN_TREND_CALLS` suppresses it rather than overclaiming.
    rows: [row({ outcome: 'ok', event_count: 200, record_count: 400 })],
    previousRows: [row({ outcome: 'ok', event_count: 1, record_count: 2 })],
    failures: [],
    rangeCaption: 'the last 7 days',
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('neither trend chip renders against a one-call baseline', async () => {
      await expect(canvas.queryByText(/pp\)/)).not.toBeInTheDocument();
      await expect(canvas.queryByText(/19,900/)).not.toBeInTheDocument();
      // …but the window's own figures still render — only the COMPARISON is
      // suppressed, not the reading.
      await expect(canvas.getByText('100%')).toBeVisible();
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
      await expect(canvas.getByText(/No agent calls recorded/)).toBeVisible();
      await expect(canvas.queryByText('Healthy')).not.toBeInTheDocument();
    });
  },
};
