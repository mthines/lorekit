import type { Meta, StoryObj } from '@storybook/react';

import { DashboardStats } from './DashboardStats';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';

/**
 * Full-view visual-regression stories for the Overview page's main content.
 *
 * `/dashboard` is a **server component** — it `await`s server actions and the
 * Supabase *server* client, so it cannot render in Storybook's browser. Its
 * largest client subtree, {@link DashboardStats}, can: it fetches scope health
 * over TanStack Query → the Supabase *browser* client → PostgREST, which MSW
 * mocks. So this stories the real component against a realistic dataset, exactly
 * as the page mounts it, without refactoring the RSC page to a client component
 * just to story it.
 *
 * Determinism: the trend chips and sparkbars are period-over-period, so the clock
 * is frozen to {@link FROZEN_NOW} (fixtures are dated relative to it) and the
 * query client retries off / never refetches — one settled render, one baseline.
 *
 * These pages are propless and data-driven, so the two visual stories are data
 * scenarios (populated vs empty) rather than a prop `Playground`.
 */
const meta: Meta<typeof DashboardStats> = {
  title: 'Pages/Dashboard Stats',
  component: DashboardStats,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
  render: () => (
    <div style={{ maxWidth: '64rem', margin: '0 auto' }} className="flex flex-col gap-6">
      <DashboardStats />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof DashboardStats>;

/** Populated Overview stats: three stat cards + the scope-health grid. */
export const Default: Story = {};

/**
 * Empty workspace — no memories yet. The stat cards read zero and the
 * scope-health grid collapses. MSW returns an empty row set for this story only.
 */
export const Empty: Story = {
  parameters: {
    msw: { handlers: memoryHandlers([]) },
  },
};
