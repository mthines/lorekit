import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { AgentBreakdown } from './AgentBreakdown';

/**
 * Interaction tests for {@link AgentBreakdown} — both sections render from one
 * row set, an unattributed client renders honestly rather than being dropped,
 * and an empty row set renders nothing.
 */
const meta: Meta<typeof AgentBreakdown> = {
  title: 'Dashboard/AgentBreakdown/Tests',
  component: AgentBreakdown,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof AgentBreakdown>;

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

export const RendersBothSectionsFromOneRowSet: Story = {
  args: {
    rows: [
      row({ client: 'mcp', kind: 'lesson', host: 'reviewer', event_count: 420, record_count: 13_020 }),
      row({ client: null, kind: null, host: null, event_count: 5, record_count: 5 }),
    ],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('who is reading shows both mcp and an unattributed row', async () => {
      await expect(canvas.getByText('mcp')).toBeVisible();
      await expect(canvas.getByText('unattributed')).toBeVisible();
    });
    await step('agent family shows the taxonomy-tagged row', async () => {
      await expect(canvas.getByText('lesson')).toBeVisible();
      await expect(canvas.getByText(/reviewer/)).toBeVisible();
    });
  },
};

export const NoUsageRowsRendersNothing: Story = {
  args: { rows: [] },
  play: async ({ canvasElement, step }) => {
    await step('an account with no usage rows renders no breakdown at all', async () => {
      // The global `ThemeFrame` decorator (`.storybook/preview.tsx`) injects a
      // `<style>` reset for deterministic snapshots into every story's DOM,
      // whose CSS text is part of `textContent` — strip it before asserting
      // the component itself rendered nothing, or the literal `''` compare
      // always fails regardless of what the component did.
      const clone = canvasElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('style, script').forEach((node) => node.remove());
      await expect(clone.textContent).toBe('');
    });
  },
};
