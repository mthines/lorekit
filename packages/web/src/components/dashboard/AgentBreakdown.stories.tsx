import type { Meta, StoryObj } from '@storybook/react';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { AgentBreakdown } from './AgentBreakdown';

/**
 * Visual-regression stories for the "who is reading" / "agent family"
 * breakdown. Pure/presentational (no internal fetch), so these pass
 * realistic `rows` directly.
 */
const meta: Meta<typeof AgentBreakdown> = {
  title: 'Dashboard/AgentBreakdown',
  component: AgentBreakdown,
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

export const Default: Story = {
  args: {
    rows: [
      row({ client: 'mcp', kind: 'lesson', host: 'reviewer', event_count: 420, record_count: 13_020 }),
      row({ client: 'mcp', kind: 'bus', host: 'aw', event_count: 55, record_count: 55 }),
      row({ client: 'cli', kind: null, host: null, event_count: 90, record_count: 2_700 }),
      row({ client: 'dashboard', kind: null, host: null, event_count: 30, record_count: 900 }),
      row({ client: null, kind: 'lesson', host: 'reviewer', event_count: 12, record_count: 300 }),
    ],
  },
};

/** No usage rows at all — renders nothing. */
export const NoUsageData: Story = {
  args: { rows: [] },
};

/** Calls exist, but none carry a memory taxonomy (e.g. an org-only account). */
export const NoAgentFamilyData: Story = {
  args: {
    rows: [row({ client: 'mcp', kind: null, host: null, event_count: 40, record_count: 1200 })],
  },
};
