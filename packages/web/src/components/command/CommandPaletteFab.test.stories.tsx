import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { CommandPaletteFab } from './CommandPaletteFab';
import { CommandPaletteProvider } from './CommandPaletteProvider';

/**
 * Interaction tests for {@link CommandPaletteFab} — `play` functions run in a
 * real browser via `@storybook/addon-vitest`. `/Tests` namespace, `test`-tagged,
 * `chromatic.disableSnapshot` so the visual-regression `afterEach` skips them.
 *
 * These assert the FAB's CONTRACT, not the palette's: it is reachable by its
 * accessible name, it is a comfortable touch target, and tapping it flips the
 * provider's open state (surfaced as `aria-expanded`). The overlay's own
 * behaviour — search, arrow keys, drill-in — belongs to `CommandPalette`, and
 * this harness deliberately does not mount it: the FAB's job ends at the state
 * flip.
 */

function Harness() {
  return (
    <CommandPaletteProvider>
      {/* The bar column the FAB positions against — `relative`, since the FAB
          is absolutely placed and would otherwise anchor to the story root. */}
      <div className="relative h-14 w-20">
        <CommandPaletteFab />
      </div>
    </CommandPaletteProvider>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Command/CommandPaletteFab/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/**
 * At rest the FAB announces itself as a collapsed dialog trigger, and its hit
 * area clears the 48dp Material / 44pt HIG floor with room to spare — the whole
 * reason the palette moved off the TopBar's 20px-tall `⌘K` chip on mobile.
 */
export const RestingState: Story = {
  play: async ({ canvasElement }) => {
    const fab = within(canvasElement).getByRole('button', { name: 'Open command palette' });

    await expect(fab).toHaveAttribute('aria-expanded', 'false');
    await expect(fab).toHaveAttribute('aria-haspopup', 'dialog');

    const { width, height } = fab.getBoundingClientRect();
    await expect(width).toBeGreaterThanOrEqual(48);
    await expect(height).toBeGreaterThanOrEqual(48);
  },
};

/** Tapping the disc opens the palette — the one thing the FAB is for. */
export const TapOpensPalette: Story = {
  play: async ({ canvasElement }) => {
    const fab = within(canvasElement).getByRole('button', { name: 'Open command palette' });

    await userEvent.click(fab);

    await waitFor(() => expect(fab).toHaveAttribute('aria-expanded', 'true'));
  },
};
