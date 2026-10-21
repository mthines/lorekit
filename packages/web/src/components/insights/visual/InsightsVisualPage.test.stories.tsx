import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InsightsVisualPage } from './InsightsVisualPage';
import { FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { visualHandlers } from './insights-visual.fixtures';

/**
 * Interaction tests for the visual `/insights` page. `/Tests` namespace,
 * `test`-tagged, and `chromatic.disableSnapshot` so the visual `afterEach`
 * skips these while the `play` functions still run in the browser.
 */
const meta: Meta<typeof InsightsVisualPage> = {
  title: 'Pages/Insights/Visual/Tests',
  component: InsightsVisualPage,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    msw: { handlers: visualHandlers() },
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof InsightsVisualPage>;

export const RendersTheLoopAndEverySection: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('one page-wide window, not two', async () => {
      await expect(canvas.getByRole('heading', { name: 'Insights', level: 1 })).toBeInTheDocument();
      await expect(canvas.getAllByRole('radiogroup', { name: /time range/i })).toHaveLength(1);
      await expect(canvas.getByRole('radiogroup', { name: 'Insights time range' })).toBeInTheDocument();
    });
    await step('the four loop stages render in order', async () => {
      const loop = await waitFor(() => canvas.getByRole('region', { name: 'The learning loop' }));
      const stages = within(loop).getAllByRole('listitem').map((li) => li.textContent ?? '');
      await expect(stages).toHaveLength(4);
      ['Learn', 'Recall', 'Promote', 'Prune'].forEach((name, i) => expect(stages[i]).toContain(name));
    });
    await step('every section heading renders', async () => {
      for (const heading of [
        'Pulse',
        'Recall flow',
        'Runs',
        'Is this lore earning its place?',
        'Where it is read',
        'Operational health',
      ]) {
        await waitFor(() => expect(canvas.getByRole('heading', { name: heading })).toBeInTheDocument());
      }
    });
    await step('Prune states its window total and that it has no daily series yet', async () => {
      // Fixture: 3 archived + 2 expired in the current window.
      await waitFor(() => expect(canvas.getByText('3 archived · 2 expired', { exact: false })).toBeVisible());
      await expect(canvas.getByText(/not recorded per day yet/)).toBeVisible();
    });
  },
};

export const RecallFlowSwapsToATable: Story = {
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement);
    const section = await waitFor(() => {
      const heading = page.getByRole('heading', { name: 'Recall flow' });
      const container = heading.closest('section');
      if (!container) throw new Error('Recall flow heading is not inside a section');
      return container;
    });
    const canvas = within(section);
    const toggle = await waitFor(() => canvas.getByRole('button', { name: 'View as table' }));
    await step('the chart is the default, the table is one click away', async () => {
      await userEvent.click(toggle);
      await expect(canvas.getByRole('button', { name: 'View as chart' })).toHaveAttribute('aria-pressed', 'true');
    });
    await step('the table carries the exact calls the bands were drawn from', async () => {
      const table = canvas.getByRole('table');
      // Fixture: mcp · memory.list · repo = 640 calls, the largest row.
      const [, firstRow] = within(table).getAllByRole('row');
      if (!firstRow) throw new Error('the table rendered no data rows');
      await expect(firstRow).toHaveTextContent('mcp');
      await expect(firstRow).toHaveTextContent('memory.list');
      await expect(firstRow).toHaveTextContent('640');
      // memory.write is not a recall, so it never appears.
      await expect(within(table).queryByText('memory.write')).toBeNull();
    });
  },
};
