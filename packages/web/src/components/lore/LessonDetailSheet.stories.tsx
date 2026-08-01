import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';

import { LessonDetailSheet } from './LessonDetailSheet';
import type { LessonEntry } from './LessonCard';
import { withQueryClient } from '@/mocks/decorators';

/**
 * Visual-regression stories for {@link LessonDetailSheet} — the memory detail
 * panel. It presents as a right-side **drawer** on desktop and a native-style
 * **bottom sheet** on mobile (below `md`); the `layout` prop pins each so both
 * are snapshot deterministically.
 *
 * The panel is `position: fixed`, which a story-root screenshot can't capture
 * on its own. Each is therefore rendered inside a **device frame** whose
 * `transform` makes it the containing block for the fixed backdrop + panel, so
 * they position within the frame and the snapshot includes them — the same
 * capture trick as `BottomSheet`, adapted for a fixed (non-portaled) panel.
 */
const meta: Meta<typeof LessonDetailSheet> = {
  title: 'Lore/LessonDetailSheet',
  component: LessonDetailSheet,
  parameters: { layout: 'centered' },
  decorators: [withQueryClient],
};

export default meta;
type Story = StoryObj<typeof LessonDetailSheet>;

const noop = () => undefined;

/** Personal lesson (no org) so no member-identity fetch fires; fixed timestamps. */
const LESSON: LessonEntry = {
  key: 'prefer-server-actions',
  value:
    'Reach for a server action over a route handler for dashboard mutations — it keeps the auth context and RLS in one place and avoids a second fetch layer.',
  tags: ['auth', 'performance', 'nextjs'],
  created_at: '2026-06-15T09:00:00Z',
  updated_at: '2026-07-28T14:30:00Z',
  scope: 'repo::mthines/lorekit',
  scope_type: 'repo',
  source_agent: 'claude',
  trigger: 'pr-review',
};

/** A frame whose `transform` contains the panel's `fixed` positioning. */
function DeviceFrame({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'relative',
        width: w,
        height: h,
        overflow: 'hidden',
        transform: 'translateZ(0)',
        borderRadius: 16,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg)',
      }}
    >
      {children}
    </div>
  );
}

/** Both presentations side by side: the mobile bottom sheet and desktop drawer. */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <DeviceFrame w={360} h={680}>
        <LessonDetailSheet lesson={LESSON} onClose={noop} layout="sheet" />
      </DeviceFrame>
      <DeviceFrame w={720} h={560}>
        <LessonDetailSheet lesson={LESSON} onClose={noop} layout="drawer" />
      </DeviceFrame>
    </div>
  ),
};

export const Playground: Story = {
  render: (args) => (
    <DeviceFrame w={args.layout === 'drawer' ? 720 : 360} h={args.layout === 'drawer' ? 560 : 680}>
      <LessonDetailSheet {...args} onClose={noop} />
    </DeviceFrame>
  ),
  args: {
    lesson: LESSON,
    layout: 'sheet',
  },
  argTypes: {
    layout: { control: 'select', options: ['sheet', 'drawer'] },
  },
};
