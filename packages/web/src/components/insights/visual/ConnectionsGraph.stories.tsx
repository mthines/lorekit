import type { Meta, StoryObj } from '@storybook/react';

import { ConnectionsGraph } from './ConnectionsGraph';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withFlagVariants, withFrozenClock, withMemorySidebar, withQueryClient } from '@/mocks/decorators';
import { EMPTY_GRAPH, GRAPH, graphHandler } from '@/mocks/memory-graph';

/** Visual baselines for the Insights Connections panel (the `memory-graph` ON arm). */
const meta: Meta<typeof ConnectionsGraph> = {
  title: 'Insights/ConnectionsGraph',
  component: ConnectionsGraph,
  parameters: { layout: 'padded', nextjs: { appDirectory: true } },
  args: { since: '2026-06-08T12:00:00.000Z', rangeCaption: 'the last 7 days' },
  decorators: [
    (Story) => <div style={{ maxWidth: 800 }}><Story /></div>,
    withFrozenClock(FROZEN_NOW),
    withFlagVariants({ 'memory-graph': 'on' }),
    withMemorySidebar,
    withQueryClient,
  ],
};

export default meta;
type Story = StoryObj<typeof ConnectionsGraph>;

/** The default lens (hubs) over a mixed-scope graph with two orphans. */
export const Hubs: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), graphHandler(GRAPH)] } },
};

/** Nothing was credited together in the window: the empty state explains how edges arise. */
export const Empty: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), graphHandler(EMPTY_GRAPH)] } },
};

/** The server capped the node count: the footer says the graph shows only the most connected. */
export const Truncated: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), graphHandler({ ...GRAPH, truncated: true })] } },
};
