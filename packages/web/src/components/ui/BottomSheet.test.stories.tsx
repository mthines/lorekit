import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { BottomSheet } from './BottomSheet';

/**
 * Interaction tests for {@link BottomSheet} — `play` functions run in a real
 * browser via `@storybook/addon-vitest`. `/Tests` namespace, `test`-tagged,
 * `chromatic.disableSnapshot` so the visual-regression `afterEach` skips them.
 *
 * The pure drag-dismiss *decision* is unit-tested in `bottom-sheet.spec.ts`;
 * these cover the wired behaviours — reveal, and the three dismissal paths
 * (Escape, backdrop tap, drag-down) — against the real portal + motion drag.
 *
 * The sheet portals to `document.body`, so the dialog is queried against the
 * body (`within(document.body)`), not the story canvas.
 */

/** Trigger + controlled sheet, with `onClose` forwarded to a spy. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <BottomSheet
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="Filter by label"
      >
        <div className="p-4 text-sm text-[var(--color-content-secondary)]">
          <p>Pick one or more labels.</p>
        </div>
      </BottomSheet>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'UI/BottomSheet/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
  args: { onClose: fn() },
};

export default meta;
type Story = StoryObj<typeof Harness>;

const body = () => within(document.body);
const backdrop = () => document.body.querySelector('[data-testid="bottom-sheet-backdrop"]');
const handle = () => document.body.querySelector('[data-testid="bottom-sheet-drag-handle"]');

async function open(canvasElement: HTMLElement) {
  const trigger = await within(canvasElement).findByRole('button', { name: /open sheet/i });
  await userEvent.click(trigger);
  return body().findByRole('dialog', { name: /filter by label/i });
}

export const OpensAndRevealsSheet: Story = {
  play: async ({ canvasElement, step }) => {
    await step('closed at rest', async () => {
      await expect(body().queryByRole('dialog')).not.toBeInTheDocument();
    });

    await step('opening reveals the sheet, its handle, and the blurred backdrop', async () => {
      const dialog = await open(canvasElement);
      await expect(dialog).toBeVisible();
      await expect(handle()).toBeInTheDocument();
      const overlay = backdrop();
      await expect(overlay).toBeInTheDocument();
      // The blur is what makes it read as a native overlay, not a flat scrim.
      await expect(overlay).toHaveClass('backdrop-blur-sm');
    });
  },
};

export const EscapeCloses: Story = {
  play: async ({ canvasElement, args, step }) => {
    await open(canvasElement);

    await step('Escape dismisses the sheet and reports onClose', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

export const BackdropTapCloses: Story = {
  play: async ({ canvasElement, args, step }) => {
    await open(canvasElement);

    await step('tapping the backdrop dismisses the sheet', async () => {
      const overlay = backdrop();
      if (!overlay) throw new Error('backdrop not found');
      await userEvent.click(overlay);
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

/**
 * Drive Motion's drag with real `PointerEvent`s. `userEvent`'s mouse sequence
 * dispatches MouseEvents, which Motion's pointer-based drag ignores; and the
 * moves must land on `window` (where Motion attaches its move/up listeners once
 * the drag begins), not only on the handle. A frame is yielded between moves so
 * Motion's rAF sampler sees each one.
 */
function pointer(type: string, target: EventTarget, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  );
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

export const DragDownCloses: Story = {
  play: async ({ canvasElement, args, step }) => {
    await open(canvasElement);

    await step('dragging the handle down past the threshold dismisses the sheet', async () => {
      const grip = handle();
      if (!grip) throw new Error('drag handle not found');
      // A deliberate downward drag well past the ~96px distance threshold; the
      // distance path closes regardless of the synthetic gesture's velocity.
      pointer('pointerdown', grip, 24);
      await nextFrame();
      for (const y of [80, 160, 240, 320]) {
        pointer('pointermove', window, y);
        await nextFrame();
      }
      pointer('pointerup', window, 320);

      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};
