import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { LessonDetailSheet } from './LessonDetailSheet';
import type { LessonEntry } from './LessonCard';
import { withQueryClient } from '@/mocks/decorators';

/**
 * Interaction tests for {@link LessonDetailSheet}'s mobile bottom-sheet
 * presentation — the three dismissal paths (backdrop tap, Escape on a clean
 * form, drag the handle down). `layout="sheet"` forces the sheet regardless of
 * the test viewport. None of these touch the network (a personal lesson skips
 * the member-identity fetch; nothing is saved or archived).
 */

const LESSON: LessonEntry = {
  key: 'prefer-server-actions',
  value: 'Reach for a server action over a route handler for dashboard mutations.',
  tags: ['auth'],
  created_at: '2026-06-15T09:00:00Z',
  updated_at: '2026-07-28T14:30:00Z',
  scope: 'repo::mthines/lorekit',
  scope_type: 'repo',
};

/** Controlled open state so a dismissal actually unmounts the panel. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <LessonDetailSheet
      lesson={open ? LESSON : null}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      layout="sheet"
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/LessonDetailSheet/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
  args: { onClose: fn() },
  decorators: [withQueryClient],
};

export default meta;
type Story = StoryObj<typeof Harness>;

const body = () => within(document.body);
const backdrop = () => document.body.querySelector('[data-testid="lesson-sheet-backdrop"]');
const handle = () => document.body.querySelector('[data-testid="lesson-sheet-drag-handle"]');

export const OpensAsASheet: Story = {
  play: async ({ step }) => {
    await step('the panel renders as a dialog with a drag handle + backdrop', async () => {
      await expect(await body().findByRole('dialog', { name: /memory detail/i })).toBeVisible();
      await expect(handle()).toBeInTheDocument();
      await expect(backdrop()).toBeInTheDocument();
    });
  },
};

export const BackdropTapCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('tapping the backdrop dismisses the sheet', async () => {
      const overlay = backdrop();
      if (!overlay) throw new Error('backdrop not found');
      await userEvent.click(overlay);
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

export const EscapeCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('Escape on a clean form dismisses the sheet', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

/** Drive Motion's drag with real PointerEvents (see BottomSheet tests). */
function pointer(type: string, target: EventTarget, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      clientX: 180,
      clientY,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  );
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

export const DragDownCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('dragging the handle down past the threshold dismisses the sheet', async () => {
      const grip = handle();
      if (!grip) throw new Error('drag handle not found');
      pointer('pointerdown', grip, 24);
      await nextFrame();
      for (const y of [90, 180, 260, 340]) {
        pointer('pointermove', window, y);
        await nextFrame();
      }
      pointer('pointerup', window, 340);
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};
