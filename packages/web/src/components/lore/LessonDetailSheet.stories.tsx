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

/** Personal lesson (no org) so no member-identity fetch fires; fixed timestamps.
 *  The value is markdown so the default Preview tab shows a rendered README-style
 *  block (heading, list, inline + fenced code, link) rather than raw source. */
const LESSON: LessonEntry = {
  key: 'prefer-server-actions',
  value: [
    '## Prefer server actions',
    '',
    'Reach for a **server action** over a route handler for dashboard mutations:',
    '',
    '- keeps the auth context and RLS in one place',
    '- avoids a second `fetch` layer',
    '',
    '```ts',
    'await updateLesson(scope, key, { value });',
    '```',
    '',
    'See the [docs](https://lorekit.io/docs) for the full rationale.',
  ].join('\n'),
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

/**
 * Full provenance — kind, host, source agent, trigger, recurrence past the
 * promotion threshold, expiry, and a complete origin (repo different from the
 * scope, so the origin's Repo row renders alongside the PR/branch/commit links).
 * Exercises every field the detail sheet's provenance block can show at once.
 */
const FULL_PROVENANCE_LESSON: LessonEntry = {
  ...LESSON,
  scope: 'global',
  scope_type: 'global',
  kind: 'lesson',
  host: 'reviewer',
  seen_count: 7,
  origin_repo: 'mthines/lorekit',
  origin_branch: 'feat/Provenance-Casing',
  origin_commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  origin_pr: 482,
};

export const FullProvenance: Story = {
  render: () => (
    <DeviceFrame w={720} h={680}>
      <LessonDetailSheet lesson={FULL_PROVENANCE_LESSON} onClose={noop} layout="drawer" />
    </DeviceFrame>
  ),
};

/**
 * All-NULL provenance — no kind, host, source agent, trigger, recurrence,
 * expiry, or origin. The provenance rows must disappear entirely rather than
 * render as empty labels, and the panel must not shift height/layout relative
 * to a populated one purely from the missing section.
 */
const NO_PROVENANCE_LESSON: LessonEntry = {
  key: 'legacy-memory-no-provenance',
  value: 'A memory written before provenance columns existed.',
  tags: [],
  created_at: '2026-01-10T09:00:00Z',
  updated_at: '2026-01-10T09:00:00Z',
  scope: 'project::lorekit-web',
  scope_type: 'project',
};

export const NoProvenance: Story = {
  render: () => (
    <DeviceFrame w={720} h={560}>
      <LessonDetailSheet lesson={NO_PROVENANCE_LESSON} onClose={noop} layout="drawer" />
    </DeviceFrame>
  ),
};

/**
 * Recurrence just below the promotion threshold (`seen_count: 1`) next to a
 * lesson at/above it (`seen_count: 3`) — the "promote?" affordance must appear
 * only for the latter.
 */
export const RecurrenceBelowAndAtThreshold: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <DeviceFrame w={360} h={560}>
        <LessonDetailSheet lesson={{ ...LESSON, seen_count: 1 }} onClose={noop} layout="drawer" />
      </DeviceFrame>
      <DeviceFrame w={360} h={560}>
        <LessonDetailSheet lesson={{ ...LESSON, seen_count: 3 }} onClose={noop} layout="drawer" />
      </DeviceFrame>
    </div>
  ),
};

/** The Edit tab pinned open — the raw-markdown textarea (drawer presentation). */
export const EditView: Story = {
  render: () => (
    <DeviceFrame w={720} h={560}>
      <LessonDetailSheet lesson={LESSON} onClose={noop} layout="drawer" initialContentTab="edit" />
    </DeviceFrame>
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
