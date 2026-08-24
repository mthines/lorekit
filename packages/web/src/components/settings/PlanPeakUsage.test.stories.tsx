import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, within, waitFor } from 'storybook/test';

import { PlanPeakUsage } from './PlanPeakUsage';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Interaction tests for {@link PlanPeakUsage} — renders the peak caption when
 * present, and renders NOTHING (no fabricated zero) when the window has no
 * write events.
 */
const meta: Meta<typeof PlanPeakUsage> = {
  title: 'Settings/PlanPeakUsage/Tests',
  component: PlanPeakUsage,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof PlanPeakUsage>;

function handlerWithPeak(peak: number | null) {
  return http.get('*/functions/v1/memories/usage', () =>
    HttpResponse.json({
      range: { since: null, until: null },
      correlation_id: null,
      summary: {
        total_events: 0, reads: 0, writes: 0, other: 0,
        records_read: 0, archived: 0, expired: 0, by_outcome: {},
        peak_memory_count: peak,
      },
      by_tool: [],
      by_scope_type: [],
    }),
  );
}

export const RendersThePeakCaption: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handlerWithPeak(4123)] } },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('shows the peak figure and the window it covers', async () => {
      await waitFor(() => expect(canvas.getByText(/peaked at 4,123 memories/i)).toBeVisible());
      await expect(canvas.getByText(/last 30 days/i)).toBeVisible();
    });
  },
};

export const RendersNothingWithNoPeakData: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handlerWithPeak(null)] } },
  play: async ({ canvasElement, step }) => {
    await step('a null peak (no write events in the window) renders no caption', async () => {
      // Give the query a moment to settle, then assert the canvas stayed empty
      // rather than showing a fabricated "Peaked at 0" line.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(canvasElement.textContent).toBe('');
    });
  },
};
