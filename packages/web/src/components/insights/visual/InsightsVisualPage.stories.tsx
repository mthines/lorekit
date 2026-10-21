import type { Meta, StoryObj } from '@storybook/react';
import { InsightsVisualPage } from './InsightsVisualPage';
import { FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { emptyVisualHandlers, visualHandlers } from './insights-visual.fixtures';

/**
 * Full-page visual-regression stories for the visual `/insights` page — the
 * `on` arm of `insights-visual`. Every section fetches over TanStack Query → a
 * REST endpoint MSW mocks with deterministic fixtures
 * (`insights-visual.fixtures.ts`), so this stories the real page.
 */
const meta: Meta<typeof InsightsVisualPage> = {
  title: 'Pages/Insights/Visual',
  component: InsightsVisualPage,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: visualHandlers() },
    // RangePicker and RunsList need the App Router context.
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  render: () => (
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <InsightsVisualPage />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof InsightsVisualPage>;

/** A busy week: writes, chosen and bulk reads, three kinds of runs, and a quieter previous week. */
export const Default: Story = {};

/** An account with no activity — every section renders its empty state rather than empty axes. */
export const Empty: Story = {
  parameters: { msw: { handlers: emptyVisualHandlers() } },
};
