import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor, within } from 'storybook/test';
import { InsightsView } from './InsightsView';
import { FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withFlagVariants } from '@/mocks/decorators';
import { visualHandlers } from './visual/insights-visual.fixtures';

/**
 * The FLAG gate on the `/insights` page body — `InsightsView` is the
 * copy-and-suffix resolver for `insights-visual`.
 *
 * What is being guarded: the flag ships OFF, so the off arm must be the
 * original page, untouched, and an unknown variant (a stale override cookie,
 * a renamed variant) must land on it too. Each arm is identified by a control
 * only it renders: the original page's "Agent activity time range" picker, and
 * the visual page's "The learning loop" strip.
 */
const meta: Meta<typeof InsightsView> = {
  title: 'Pages/Insights/InsightsView/Tests',
  component: InsightsView,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    // A superset of both arms' endpoints, so either page renders against data.
    msw: { handlers: visualHandlers() },
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof InsightsView>;

async function expectOriginalPage(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole('radiogroup', { name: 'Agent activity time range' })).toBeInTheDocument());
  await expect(canvas.queryByRole('region', { name: 'The learning loop' })).toBeNull();
  await expect(canvas.queryByRole('radiogroup', { name: 'Insights time range' })).toBeNull();
}

export const OffRendersTheOriginalPage: Story = {
  decorators: [withFlagVariants({ 'insights-visual': 'off' })],
  play: async ({ canvasElement }) => expectOriginalPage(canvasElement),
};

export const OnRendersTheVisualPage: Story = {
  decorators: [withFlagVariants({ 'insights-visual': 'on' })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('region', { name: 'The learning loop' })).toBeInTheDocument());
    await expect(canvas.getByRole('radiogroup', { name: 'Insights time range' })).toBeInTheDocument();
    await expect(canvas.queryByRole('radiogroup', { name: 'Agent activity time range' })).toBeNull();
  },
};

export const UnknownVariantFallsBackToTheOriginalPage: Story = {
  decorators: [withFlagVariants({ 'insights-visual': 'bogus' })],
  play: async ({ canvasElement }) => expectOriginalPage(canvasElement),
};
