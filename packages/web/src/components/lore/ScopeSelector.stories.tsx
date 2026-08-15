import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';

import { ScopeSelector } from './ScopeSelector';
import type { ScopeNode } from './ScopeTree';

/**
 * Visual-regression stories for the scope chip selector — the persistent,
 * card-less row that replaced the left scope tree. `Default` shows the collapsed
 * row (top scopes + Browse all); `Selected` lights a chip; `Expanded` opens the
 * searchable chip list.
 */
const NODES: ScopeNode[] = [
  { scope: 'repo::mthines/lorekit', type: 'repo', label: 'mthines/lorekit', count: 1056 },
  { scope: 'repo::dash0hq/dash0', type: 'repo', label: 'dash0hq/dash0', count: 369 },
  { scope: 'global', type: 'global', label: 'global', count: 255 },
  { scope: 'repo::mthines/agent-skills', type: 'repo', label: 'mthines/agent-skills', count: 166 },
  { scope: 'project::lorekit-web-daily-report', type: 'project', label: 'lorekit-web-daily-report', count: 45 },
  { scope: 'repo::mthines/mainline', type: 'repo', label: 'mthines/mainline', count: 40 },
  { scope: 'repo::mthines/yourstory-ai', type: 'repo', label: 'mthines/yourstory-ai', count: 18 },
  { scope: 'repo::mthines/graft', type: 'repo', label: 'mthines/graft', count: 4 },
];

const meta: Meta<typeof ScopeSelector> = {
  title: 'Lore/ScopeSelector',
  component: ScopeSelector,
  parameters: { layout: 'padded' },
  args: { nodes: NODES, totalCount: 1953, onSelect: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '52rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ScopeSelector>;

/** Collapsed row, nothing selected — "All scopes" is lit. */
export const Default: Story = { args: { selected: null } };

/** A scope selected — its chip is lit, the row is otherwise unchanged. */
export const Selected: Story = { args: { selected: 'repo::mthines/lorekit' } };

/**
 * The searchable chip list opened via `Browse all`. The open state is internal,
 * so the play function clicks the toggle before the screenshot is taken — this
 * is the only baseline that covers the long-tail browse surface.
 */
export const Expanded: Story = {
  args: { selected: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /browse all/i }));
    await canvas.findByPlaceholderText(/filter scopes/i);
  },
};
