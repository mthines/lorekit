import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';

import { CommandPalette } from './CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from './CommandPaletteProvider';
import { useCommand } from './useCommand';
import type { Command } from './types';

/**
 * Interaction tests for {@link CommandPalette} — `play` functions run in a real
 * browser via `@storybook/addon-vitest`. `/Tests` namespace, `test`-tagged,
 * `chromatic.disableSnapshot` so the visual-regression `afterEach` skips them.
 *
 * These cover the palette's LAYOUT contract in a short viewport, which is the
 * phone-with-keyboard case: the panel used to be the sum of its parts, so on a
 * phone (where focusing the search input opens the keyboard the instant the
 * palette does) the command list and the footer hint sat under the keyboard,
 * clipped by `overflow-hidden` rather than scrollable. The fix is a height cap
 * plus a shrinkable list, and geometry is the only honest way to assert it — a
 * screenshot shows the panel but not whether the rows below the fold are
 * reachable.
 *
 * The frame is passed as `container` so the overlay stays inside the story root
 * (the palette otherwise portals to `document.body`) AND so the frame, not the
 * Storybook iframe, is the viewport being constrained.
 */

const noop = () => undefined;

/** Enough commands that the list must scroll in any frame this file uses. */
const SAMPLE: Command[] = Array.from({ length: 14 }, (_, i) => ({
  id: `cmd-${i}`,
  label: `Command number ${i + 1}`,
  group: i < 7 ? 'Docs' : 'Navigate',
  onSelect: noop,
}));

function Register({ command }: { command: Command }) {
  useCommand(command);
  return null;
}

function OpenOnMount() {
  const { openPalette } = useCommandPalette();
  useEffect(() => {
    // rAF so every sibling's useCommand registration effect has run first,
    // otherwise openPalette would snapshot an empty registry.
    const id = requestAnimationFrame(() => openPalette('button'));
    return () => cancelAnimationFrame(id);
  }, [openPalette]);
  return null;
}

/** `height` stands in for the space a virtual keyboard leaves behind. */
function Harness({ width, height }: { width: number; height: number }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <CommandPaletteProvider>
      {SAMPLE.map((c) => (
        <Register key={c.id} command={c} />
      ))}
      <OpenOnMount />
      <div
        ref={setFrame}
        data-testid="viewport"
        style={{ width, height }}
        className="relative overflow-hidden bg-[var(--color-bg)]"
      >
        {frame && <CommandPalette container={frame} />}
      </div>
    </CommandPaletteProvider>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Command/CommandPalette/Tests',
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
 * A phone with the keyboard up (390 × 420). The whole panel — footer hint
 * included — must sit inside the frame, and the list must be the part that
 * gave up the height, scrolling rather than clipping.
 */
export const FitsAPhoneWithTheKeyboardUp: Story = {
  args: { width: 390, height: 420 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole('dialog', { name: 'Command Palette' });
    const frame = canvas.getByTestId('viewport');

    const panel = dialog.getBoundingClientRect();
    const viewport = frame.getBoundingClientRect();

    // Nothing below the fold: if this regresses, the footer and the last rows
    // are unreachable behind the keyboard.
    await expect(panel.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    await expect(panel.top).toBeGreaterThanOrEqual(viewport.top - 1);

    // The list is what shrank, and it stayed scrollable.
    const list = canvas.getByRole('listbox');
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

    // The search input did NOT get crushed to absorb the deficit.
    const input = canvas.getByRole('combobox');
    await expect(input.getBoundingClientRect().height).toBeGreaterThan(16);

    // The footer hint is still on screen.
    const footer = await canvas.findByText('navigate');
    await expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.bottom + 1,
    );
  },
};

/**
 * The desktop case, as a control: given room, the panel does NOT stretch to the
 * viewport — the list keeps its own `max-h-80` ceiling, so the height cap is a
 * ceiling and not a `height: 100%`.
 */
export const DoesNotStretchWhenThereIsRoom: Story = {
  args: { width: 960, height: 900 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole('dialog', { name: 'Command Palette' });

    await expect(dialog.getBoundingClientRect().height).toBeLessThan(500);
  },
};
