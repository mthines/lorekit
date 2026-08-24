import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { PlanPeakUsage } from './PlanPeakUsage';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Visual-regression stories for the plan page's "peaked at N" caption. The
 * component fetches over TanStack Query → `GET /memories/usage`, mocked per
 * story since the shared `memoryHandlers()` fixture's usage mock does not
 * carry a `peak_memory_count`.
 */
const meta: Meta<typeof PlanPeakUsage> = {
  title: 'Settings/PlanPeakUsage',
  component: PlanPeakUsage,
  parameters: { layout: 'padded' },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof PlanPeakUsage>;

function handlerWithPeak(peak: number | null) {
  return http.get('*/functions/v1/memories/usage', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      range: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
      correlation_id: null,
      summary: {
        total_events: 100, reads: 80, writes: 20, other: 0,
        records_read: 2000, archived: 1, expired: 0, by_outcome: { ok: 100 },
        peak_memory_count: peak,
      },
      by_tool: [],
      by_scope_type: [],
    });
  });
}

export const Default: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handlerWithPeak(4123)] } },
};

/** No write events in the window — renders nothing. */
export const NoPeakData: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handlerWithPeak(null)] } },
};
