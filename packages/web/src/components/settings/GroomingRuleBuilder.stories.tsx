import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, waitFor, within } from 'storybook/test';

import { GroomingRuleBuilder } from './GroomingRuleBuilder';
import { groomHandlers, memoryHandlers, DEFAULT_GROOM_POLICIES } from '@/mocks/memories';
import { withQueryClient } from '@/mocks/decorators';
import type { MockRetentionPolicy } from '@/mocks/memories';

/**
 * Visual-regression + Playground stories for {@link GroomingRuleBuilder} —
 * Settings → Grooming, now LIST-FIRST: the saved policies and an **Add policy**
 * button up front, the rule form in a dialog. MSW-mocked per `docs/storybook.md`;
 * `groomHandlers()` mints a fresh in-memory policy list per story mount and
 * `memoryHandlers()` supplies the scope catalog the dialog's scope picker reads,
 * so a create/delete round trip in one story never bleeds into another.
 *
 * No toast decorator needed — the component calls sonner's `showToast`
 * (`@/lib/toast`) directly, and sonner renders nothing without a mounted
 * `<Toaster>`, so a toast call here is simply a no-op rather than an error.
 */

/** Groom endpoints + the scope catalog the dialog's scope picker reads. */
function handlers(policies?: MockRetentionPolicy[]) {
  return [...groomHandlers(policies), ...memoryHandlers()];
}

const meta: Meta<typeof GroomingRuleBuilder> = {
  title: 'Settings/GroomingRuleBuilder',
  component: GroomingRuleBuilder,
  parameters: {
    layout: 'padded',
    msw: { handlers: handlers() },
    // The component reads `useRouter`/`useSearchParams` to consume the
    // one-shot `?prefillScope=…` handoff from the Lore Explorer.
    // `appDirectory: true` mounts `@storybook/nextjs-vite`'s App Router
    // context so those hooks resolve instead of throwing "expected app
    // router to be mounted".
    nextjs: { appDirectory: true },
  },
  decorators: [withQueryClient],
};

export default meta;
type Story = StoryObj<typeof GroomingRuleBuilder>;

/** No saved policies yet — the teaching empty state + the Add CTA. */
export const ListEmpty: Story = {
  parameters: { msw: { handlers: handlers([]) } },
};

/** Several saved policies, mixing review and auto+enabled modes. */
export const ListPopulated: Story = {
  parameters: {
    msw: {
      handlers: handlers([
        ...DEFAULT_GROOM_POLICIES,
        {
          id: 'policy-2',
          scope: 'global',
          name: 'Old unseen notes',
          mode: 'auto',
          enabled: true,
          min_age_days: null,
          unseen_days: 120,
          max_seen_count: null,
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'policy-3',
          scope: 'project::demo',
          name: 'Rarely-recurring lore',
          mode: 'review',
          enabled: false,
          min_age_days: 30,
          unseen_days: null,
          max_seen_count: 2,
          created_at: '2026-04-15T00:00:00.000Z',
          updated_at: '2026-04-15T00:00:00.000Z',
        },
      ]),
    },
  },
};

/** The create form open in its dialog — the state Add drops you into. */
export const DialogOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /add policy/i }));
    await waitFor(async () => {
      await within(document.body).findByText(/new grooming policy/i);
    });
  },
};
