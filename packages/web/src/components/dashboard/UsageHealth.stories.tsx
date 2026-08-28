import type { Meta, StoryObj } from '@storybook/react';
import type { UsageStatRow } from '@lorekit/schemas/usage';
import { UsageHealth } from './UsageHealth';

/**
 * Visual-regression stories for the operational-health diagnostics — friction,
 * latency, and coverage gaps, all derived from `GET /memories/usage`'s
 * `by_tool` rows. `UsageHealth` is pure/presentational (no internal fetch), so
 * these pass realistic `rows` directly rather than mocking a network call.
 */
const meta: Meta<typeof UsageHealth> = {
  title: 'Dashboard/UsageHealth',
  component: UsageHealth,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '60rem' }}>
        <Story />
      </div>
    ),
  ],
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

/** Live production shape: friction, latency and a branch-scope coverage gap all at once. */
export const Default: Story = {
  args: {
    rows: [
      // Friction — 155 identical failing org.create calls.
      row({ tool_name: 'org.create', outcome: 'error', scope_type: null, event_count: 155, record_count: 0, total_duration_ms: 46500 }),
      row({ tool_name: 'memory.write', outcome: 'cap_exceeded', scope_type: 'project', event_count: 3, record_count: 0, total_duration_ms: 300 }),
      // Latency.
      row({ tool_name: 'memory.search', scope_type: 'global', event_count: 100, total_duration_ms: 38_600 }),
      row({ tool_name: 'memory.list', scope_type: 'invalid', event_count: 50, total_duration_ms: 18_450 }),
      row({ tool_name: 'memory.list', scope_type: 'global', event_count: 80, total_duration_ms: 21_120 }),
      row({ tool_name: 'memory.read', scope_type: 'repo', event_count: 200, total_duration_ms: 23_200 }),
      // Coverage gaps — the documented branch/project shape against a healthy repo/global.
      row({ tool_name: 'memory.list', scope_type: 'branch', event_count: 1176, record_count: 15, total_duration_ms: null }),
      row({ tool_name: 'memory.list', scope_type: 'project', event_count: 2000, record_count: 900, total_duration_ms: null }),
      row({ tool_name: 'memory.search', scope_type: 'project', event_count: 746, record_count: 230, total_duration_ms: null }),
      row({ tool_name: 'memory.list', scope_type: 'repo', event_count: 500, record_count: 15_750, total_duration_ms: null }),
      row({ tool_name: 'memory.list', scope_type: 'global', event_count: 400, record_count: 13_240, total_duration_ms: null }),
      // Legacy free-text scope_type — must bucket into "other", never its own row.
      row({ tool_name: 'memory.search', scope_type: 'bogusprefix', event_count: 4, record_count: 1, total_duration_ms: 400 }),
    ],
  },
};

/** No usage rows at all — renders nothing rather than three empty sections. */
export const NoUsageData: Story = {
  args: { rows: [] },
};

/** Usage rows exist, but none failed and none are scope-bearing (e.g. an org-only account). */
export const NoFrictionOrCoverage: Story = {
  args: {
    rows: [
      row({ tool_name: 'org.list', outcome: 'ok', scope_type: null, event_count: 40, total_duration_ms: 4000 }),
    ],
  },
};
