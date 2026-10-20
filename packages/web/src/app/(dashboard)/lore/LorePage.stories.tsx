import type { Meta, StoryObj } from '@storybook/react';

import LorePageClient from './LorePageClient';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import {
  withQueryClient,
  withFrozenClock,
  withMemorySidebar,
  withExplorerResults,
  withFeatureFlags,
} from '@/mocks/decorators';

/**
 * True full-page visual-regression stories for the `/lore` client subtree.
 *
 * `/lore/page.tsx` is now a server wrapper (onboarding + the first-token mint,
 * mirroring `/insights`) that a server component cannot render in the browser —
 * so this story mounts its extracted `'use client'` body, `LorePageClient`,
 * directly, the same convention `/insights` uses for `InsightsPage`.
 * `LorePageClient` drives its scope tree, contribution heatmap and lesson list
 * from TanStack Query hooks (`useScopeTree`, `useLoreData`, `useMemories`) that
 * call the `memories` REST function from the browser, which MSW mocks. So the
 * component renders end-to-end here, not a hand-assembled subtree.
 *
 * The lesson list used to read the `listMemories` server action, which had no
 * session in the mocked context and returned an empty page, so this story
 * showed "No memories in this scope". The list is a browser request now
 * (`POST /memories/list`), so it populates from the same fixtures as the tree.
 *
 * Determinism: the clock is frozen to {@link FROZEN_NOW} (heatmap + freshness are
 * time-relative) and the query client retries off / never refetches.
 *
 * The component is propless and data-driven, so the two visual stories are data
 * scenarios (populated tree vs fully-empty workspace), not a prop `Playground`.
 */
const meta: Meta<typeof LorePageClient> = {
  title: 'Pages/Lore Explorer',
  component: LorePageClient,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
    // The page reads `useRouter`/`usePathname`/`useSearchParams` (via `useUrlState`)
    // to keep scope/search/date filters in the URL. `appDirectory: true` mounts
    // `@storybook/nextjs-vite`'s App Router context so those hooks resolve instead
    // of throwing "expected app router to be mounted".
    nextjs: { appDirectory: true },
  },
  decorators: [
    withFrozenClock(FROZEN_NOW),
    withMemorySidebar,
    withExplorerResults,
    withFeatureFlags,
    withQueryClient,
  ],
};

export default meta;
type Story = StoryObj<typeof LorePageClient>;

/**
 * Populated Lore Explorer: the scope tree, contribution heatmap, view-mode tabs,
 * filter bars and the lesson list all resolve from the MSW-mocked dataset.
 */
export const Default: Story = {};

/**
 * Empty workspace — no memories written yet. The scope sidebar, heatmap, and
 * results panel all render their empty states. MSW returns no rows for this
 * story only.
 */
export const Empty: Story = {
  parameters: {
    msw: { handlers: memoryHandlers([]) },
  },
};
