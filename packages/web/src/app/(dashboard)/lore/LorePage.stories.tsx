import type { Meta, StoryObj } from '@storybook/react';

import LorePage from './page';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock, withMemorySidebar } from '@/mocks/decorators';

/**
 * True full-page visual-regression stories for the `/lore` client page.
 *
 * Unlike the server-component pages, `/lore` is `'use client'`: it drives its
 * scope tree and contribution heatmap from `useScopeTree` / `useLoreData`
 * — TanStack Query hooks that call the Supabase *browser* client (PostgREST over
 * HTTP), which MSW mocks. So the actual page component renders end-to-end here,
 * not a hand-assembled subtree.
 *
 * The lesson list inside `LoreExplorer` reads the `listMemories` **server
 * action**. With `next/headers` auto-mocked by `@storybook/nextjs-vite` it does
 * execute in the browser, but it is gated on `supabase.auth.getUser()`, which
 * short-circuits to no session in the mocked context and returns an empty page —
 * so the results panel renders its "No memories in this scope" empty state while
 * the scope tree + heatmap populate from the MSW-mocked PostgREST reads. That is
 * the honest edge of the mixed rendering model: the page renders end-to-end, and
 * every part that is driven by a *browser* fetch is populated.
 *
 * Determinism: the clock is frozen to {@link FROZEN_NOW} (heatmap + freshness are
 * time-relative) and the query client retries off / never refetches.
 *
 * The page is propless and data-driven, so the two visual stories are data
 * scenarios (populated tree vs fully-empty workspace), not a prop `Playground`.
 */
const meta: Meta<typeof LorePage> = {
  title: 'Pages/Lore Explorer',
  component: LorePage,
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
    // The page reads `useRouter`/`usePathname`/`useSearchParams` (via `useUrlState`)
    // to keep scope/search/date filters in the URL. `appDirectory: true` mounts
    // `@storybook/nextjs-vite`'s App Router context so those hooks resolve instead
    // of throwing "expected app router to be mounted".
    nextjs: { appDirectory: true },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withMemorySidebar, withQueryClient],
};

export default meta;
type Story = StoryObj<typeof LorePage>;

/**
 * Populated Lore Explorer: the scope tree, contribution heatmap, view-mode tabs,
 * and filter bars all resolve from the MSW-mocked dataset. The lesson results
 * panel shows its empty state (see the auth-gate note above).
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
