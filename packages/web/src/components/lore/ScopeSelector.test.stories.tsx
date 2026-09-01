import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ScopeSelector } from './ScopeSelector';
import type { ScopeNode } from './ScopeTree';

/**
 * Interaction tests for the scope chip selector. `/Tests` namespace,
 * `test`-tagged, `chromatic.disableSnapshot` so the visual `afterEach` skips
 * these — the assertions are behavioural, not pixel.
 *
 * Assertions key off ROLES and COUNTS, not the badge's rendered text, so they
 * survive a change to how a scope label is formatted.
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
  title: 'Lore/ScopeSelector/Tests',
  component: ScopeSelector,
  tags: ['test'],
  parameters: { layout: 'padded', chromatic: { disableSnapshot: true } },
  args: { nodes: NODES, selected: null, totalCount: 1953, onSelect: fn() },
};

export default meta;
type Story = StoryObj<typeof ScopeSelector>;

/** Clicking a scope chip reports that scope; the row never has to be expanded. */
export const SelectsAScope: Story = {
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    await step('the first scope chip after "All scopes" selects that scope', async () => {
      const row = within(await canvas.findByRole('radiogroup', { name: /filter by scope/i }));
      // radios[0] is "All scopes"; radios[1] is the first (highest-count) scope.
      await userEvent.click(row.getAllByRole('radio')[1]);
      await expect(args.onSelect).toHaveBeenCalledWith('repo::mthines/lorekit');
    });
  },
};

/** "Browse all" reveals the searchable list; typing narrows it to the match. */
export const BrowseAllAndSearch: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('Browse all opens the searchable chip list', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: /browse all/i }));
      const search = await canvas.findByRole('searchbox', { name: /filter scopes/i });
      await userEvent.type(search, 'graft');
      const list = within(await canvas.findByRole('radiogroup', { name: 'All scopes' }));
      await expect(list.getAllByRole('radio')).toHaveLength(1);
    });
  },
};

/** "All scopes" clears the selection back to null. */
export const AllScopesClears: Story = {
  args: { selected: 'repo::mthines/lorekit' },
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    await step('the All scopes chip reports null', async () => {
      const row = within(await canvas.findByRole('radiogroup', { name: /filter by scope/i }));
      await userEvent.click(row.getAllByRole('radio')[0]);
      await expect(args.onSelect).toHaveBeenCalledWith(null);
    });
  },
};

/**
 * Branch scopes are noise here — they churn constantly — so this picker
 * excludes them entirely, both from the strip and from Browse all's
 * searchable list. `GroomingRuleBuilder` has its own separate scope picker
 * that still surfaces branches.
 */
export const BranchScopesHidden: Story = {
  args: {
    // A branch nests under its repo, matching the shape `buildScopeTree`
    // produces — never a top-level array entry.
    nodes: NODES.map((node): ScopeNode =>
      node.scope === 'repo::mthines/lorekit'
        ? {
            ...node,
            children: [
              { scope: 'branch::mthines/lorekit::feat/x', type: 'branch', label: 'feat/x', count: 3 },
            ],
          }
        : node,
    ),
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the strip never lights a chip for the branch', async () => {
      const row = within(await canvas.findByRole('radiogroup', { name: /filter by scope/i }));
      expect(row.queryByText('feat/x')).not.toBeInTheDocument();
    });
    await step('Browse all never lists the branch either', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: /browse all/i }));
      const list = within(await canvas.findByRole('radiogroup', { name: 'All scopes' }));
      expect(list.queryByText('feat/x')).not.toBeInTheDocument();
    });
  },
};
