import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';

import { GroomingRuleBuilder } from './GroomingRuleBuilder';
import { groomHandlers, DEFAULT_GROOM_POLICIES } from '@/mocks/memories';
import { withQueryClient } from '@/mocks/decorators';
import { ToastProvider } from '@/components/providers/ToastProvider';

/**
 * Visual-regression + Playground stories for {@link GroomingRuleBuilder} —
 * Settings → Grooming's rule builder (live match count, review/auto toggle,
 * Run-now, and the saved-policies list). MSW-mocked per `docs/storybook.md`;
 * `groomHandlers()` mints a fresh in-memory policy list per story mount, so
 * a create/delete round trip in one story never bleeds into another.
 */
function WithToast({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

const meta: Meta<typeof GroomingRuleBuilder> = {
  title: 'Settings/GroomingRuleBuilder',
  component: GroomingRuleBuilder,
  parameters: {
    layout: 'padded',
    msw: { handlers: groomHandlers() },
  },
  decorators: [(Story) => <WithToast><Story /></WithToast>, withQueryClient],
};

export default meta;
type Story = StoryObj<typeof GroomingRuleBuilder>;

/** One saved policy, the default fixture set. */
export const Default: Story = {};

/** No saved policies yet — the empty state. */
export const NoPolicies: Story = {
  parameters: { msw: { handlers: groomHandlers([]) } },
};

/** Several saved policies, mixing review and auto+enabled modes. */
export const Playground: Story = {
  parameters: {
    msw: {
      handlers: groomHandlers([
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
