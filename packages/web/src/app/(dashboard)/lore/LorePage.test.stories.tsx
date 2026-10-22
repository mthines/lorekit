import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

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
 * Interaction tests for the `/lore` client subtree — asserts it resolves
 * against the MSW-mocked data and the scope selector renders its chips.
 * `/lore/page.tsx` is a server wrapper now (see `LorePage.stories.tsx`), so
 * this mounts the extracted `LorePageClient` directly.
 * `/Tests` namespace, `test`-tagged, `chromatic.disableSnapshot` so the visual
 * `afterEach` skips these while the `play` functions run in the browser.
 */
const meta: Meta<typeof LorePageClient> = {
  title: 'Pages/Lore Explorer/Tests',
  component: LorePageClient,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'fullscreen',
    msw: { handlers: memoryHandlers() },
    // Mount the App Router context so `useRouter`/`useSearchParams` (via
    // `useUrlState`) resolve — see the note in `LorePage.stories.tsx`.
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

export const RendersScopeSelector: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('The page heading renders immediately', async () => {
      await expect(
        await canvas.findByRole('heading', { name: /lore explorer/i }),
      ).toBeInTheDocument();
    });

    await step('The MSW-mocked scopes resolve into selector chips', async () => {
      // The scope selector is a radiogroup of chips. "All scopes" is a constant
      // an EMPTY scopes response would still render, so its presence proves
      // nothing about what the query returned — assert MORE than one radio, i.e.
      // at least one real mocked scope chip beside "All scopes", which only
      // appears once the /memories/scopes query has settled with rows.
      const group = within(await canvas.findByRole('radiogroup', { name: /filter by scope/i }));
      await expect(group.getAllByRole('radio').length).toBeGreaterThan(1);
    });
  },
};

/** The page's own `?sort=` value, as a reload would read it. */
const sortInAddressBar = () => new URLSearchParams(window.location.search).get('sort');

/**
 * A sort choice is in the address bar the moment it is made, so a reload right
 * after it keeps it. It used to reach the URL only after a server render
 * returned — 4.3 s on PR #718's preview, where a reload in between restored
 * Newest. Storybook's App Router mock never feeds `window.history` back into
 * `useSearchParams`, so this reads the browser's own location: what a reload
 * would load.
 */
export const SortChoiceIsInTheAddressBarAtOnce: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    // Exact name: the phone-width control is labelled "Sort memories: <order>".
    const sort = await canvas.findByRole('combobox', { name: 'Sort memories' });

    await step('Choosing Recent read writes sort to the URL in the same step', async () => {
      await userEvent.selectOptions(sort, 'Recent read');
      await expect(sortInAddressBar()).toBe('"last_opened_at"');
      await expect(sort).toHaveValue('last_opened_at');
    });

    await step('Choosing Newest, the default, removes sort again', async () => {
      await userEvent.selectOptions(sort, 'Newest');
      await expect(sortInAddressBar()).toBeNull();
      await expect(sort).toHaveValue('created_at');
    });
  },
};

