import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { UsageHealth } from './UsageHealth';

/**
 * Interaction tests for {@link UsageHealth} — asserts the three diagnostics
 * render from one row set, unknown scope_types bucket rather than getting
 * their own row, and an empty account renders nothing (not three empty
 * sections with zeros).
 */
const meta: Meta<typeof UsageHealth> = {
  title: 'Dashboard/UsageHealth/Tests',
  component: UsageHealth,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof UsageHealth>;

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

export const RendersAllThreeSectionsFromOneRowSet: Story = {
  args: {
    rows: [
      row({ tool_name: 'org.create', outcome: 'error', scope_type: null, event_count: 155, total_duration_ms: 46500 }),
      row({ tool_name: 'memory.search', scope_type: 'global', event_count: 10, total_duration_ms: 3860 }),
      row({ tool_name: 'memory.list', scope_type: 'branch', event_count: 1176, record_count: 15, total_duration_ms: null }),
    ],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('friction shows the repeated failure as one row with its full count', async () => {
      await expect(canvas.getByText('org.create')).toBeVisible();
      await expect(canvas.getByText('×155')).toBeVisible();
      await expect(canvas.getByText('error')).toBeVisible();
    });
    await step('latency shows the mean duration for the timed call', async () => {
      await expect(canvas.getByText(/386 ms/)).toBeVisible();
    });
    await step('coverage gaps shows the branch scope\'s asked/found figures', async () => {
      await expect(canvas.getByText(/asked 1,176× → found 15/)).toBeVisible();
    });
  },
};

export const UnknownScopeTypeBucketsIntoOther: Story = {
  args: {
    rows: [
      row({ tool_name: 'memory.search', scope_type: 'dash0', event_count: 5, record_count: 1, total_duration_ms: 500 }),
      row({ tool_name: 'memory.list', scope_type: 'bogusprefix', event_count: 3, record_count: 0, total_duration_ms: null }),
    ],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('legacy free-text scope_type values render as "other", never their own row', async () => {
      await expect(canvas.queryByText('dash0')).not.toBeInTheDocument();
      await expect(canvas.queryByText('bogusprefix')).not.toBeInTheDocument();
      await expect(canvas.getByText('other')).toBeVisible();
    });
  },
};

export const NoUsageRowsRendersNothing: Story = {
  args: { rows: [] },
  play: async ({ canvasElement, step }) => {
    await step('an account with no usage rows renders no diagnostics section at all', async () => {
      // `UsageHealth` returns null on an empty row set, so the canvas is
      // literally empty rather than showing three "No … in this window" cards.
      await expect(canvasElement.textContent).toBe('');
    });
  },
};
