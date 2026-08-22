import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { within } from 'storybook/test';
import {
  Rocket,
  HardDrive,
  Cloud,
  Users,
  Lock,
  Tag,
  FileCog,
  LayoutDashboard,
  BookOpen,
  Settings,
  Library,
} from 'lucide-react';

import { CommandPalette } from './CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from './CommandPaletteProvider';
import { useCommand } from './useCommand';
import type { Command } from './types';

/**
 * Visual-regression stories for the {@link CommandPalette} overlay.
 *
 * The palette needs three things to render its resting state: the
 * {@link CommandPaletteProvider} context, a set of registered commands, and
 * `open === true`. The `PaletteHarness` decorator wires all three — it mounts
 * sample commands (mirroring the real Docs / Navigate / Lore groups, with the
 * same icons + descriptions + `g→` shortcuts — descriptions feed the search
 * index, they are not rendered per row) and force-opens the palette on mount so
 * the snapshot captures the populated list.
 *
 * The interactive behaviour (search, arrow-key selection, nested drill-in) is
 * the palette's own concern and is covered by the provider's chord engine; these
 * stories fix the LOOK — type scale, icon balance, group separators, selected
 * row — which is what visual regression protects.
 */

const noop = () => undefined;

/** Sample commands mirroring the real registry's shape (icons + descriptions). */
function SampleCommands() {
  const docs: Array<Omit<Command, 'onSelect'>> = [
    { id: 'd-setup', label: 'Getting started', description: 'Connect your agent and generate a token', icon: <Rocket className="size-4" />, group: 'Docs' },
    { id: 'd-offline', label: 'Offline storage', description: 'Store lessons locally without a server', icon: <HardDrive className="size-4" />, group: 'Docs' },
    { id: 'd-remote', label: 'Remote storage', description: 'Sync lessons to the hosted LoreKit server', icon: <Cloud className="size-4" />, group: 'Docs' },
    { id: 'd-team', label: 'Team sharing', description: 'Share lore across your organization', icon: <Users className="size-4" />, group: 'Docs' },
    { id: 'd-private', label: 'Private lore', description: 'Keep sensitive lessons private', icon: <Lock className="size-4" />, group: 'Docs' },
    { id: 'd-tags', label: 'Tags & scopes', description: 'Organise lessons by scope and tag', icon: <Tag className="size-4" />, group: 'Docs' },
    { id: 'd-config', label: 'Configuration', description: 'All .lorekit.json / config.json options', icon: <FileCog className="size-4" />, group: 'Docs' },
  ];
  const nav: Command[] = [
    { id: 'n-overview', label: 'Go to Overview', icon: <LayoutDashboard className="size-4" />, group: 'Navigate', shortcut: { keys: ['g', 'o'] }, onSelect: noop },
    { id: 'n-explorer', label: 'Go to Lore Explorer', icon: <BookOpen className="size-4" />, group: 'Navigate', shortcut: { keys: ['g', 'e'] }, onSelect: noop },
    { id: 'n-settings', label: 'Go to Settings', icon: <Settings className="size-4" />, group: 'Navigate', shortcut: { keys: ['g', 's'] }, onSelect: noop },
  ];
  // useCommand at stable hook positions — one child component per command.
  return (
    <>
      {docs.map((c) => <Register key={c.id} command={{ ...c, onSelect: noop }} />)}
      {nav.map((c) => <Register key={c.id} command={c} />)}
      <Register
        command={{
          id: 'l-open',
          label: 'Open Lesson…',
          icon: <Library className="size-4" />,
          group: 'Lore',
          children: () => [],
        }}
      />
    </>
  );
}

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

/**
 * A positioned frame that stands in for the viewport.
 *
 * The palette portals its backdrop out of the React tree, so a story that let
 * it default to `document.body` would render OUTSIDE `#storybook-root` — which
 * is exactly what the visual-regression hook screenshots, leaving an empty
 * baseline. Passing the frame as `container` keeps the overlay inside the story
 * root, the same trick `BottomSheet.stories.tsx` uses.
 */
function ViewportFrame({
  children,
}: {
  children: (frame: HTMLElement) => React.ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setFrame}
      className="relative h-[640px] w-[960px] overflow-hidden bg-[var(--color-bg)]"
    >
      {frame && children(frame)}
    </div>
  );
}

function PaletteHarness() {
  return (
    <CommandPaletteProvider>
      <SampleCommands />
      <OpenOnMount />
      <ViewportFrame>{(frame) => <CommandPalette container={frame} />}</ViewportFrame>
    </CommandPaletteProvider>
  );
}

const meta: Meta<typeof CommandPalette> = {
  title: 'Command/CommandPalette',
  component: CommandPalette,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CommandPalette>;

/**
 * The resting palette, opened at the root level with representative commands —
 * the Docs group (single-line, icon + label rows) above the Navigate
 * group (label + `g→` shortcut), with the first row selected.
 */
export const Default: Story = {
  render: () => <PaletteHarness />,
  // The harness opens the palette from a `requestAnimationFrame`, so without a
  // `play` the visual-regression `afterEach` (which runs right after `play`)
  // could screenshot before the dialog mounts. Awaiting the dialog makes the
  // snapshot deterministic instead of relying on frame timing.
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('dialog', { name: 'Command Palette' });
  },
};
