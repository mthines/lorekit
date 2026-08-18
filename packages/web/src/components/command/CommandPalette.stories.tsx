import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
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
 * same icons + descriptions + `g→` shortcuts) and force-opens the palette on
 * mount so the snapshot captures the populated list.
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

function PaletteHarness() {
  return (
    <CommandPaletteProvider>
      <SampleCommands />
      <OpenOnMount />
      <CommandPalette />
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
 * the Docs group (icon + label + description two-liners) above the Navigate
 * group (label + `g→` shortcut), with the first row selected.
 */
export const Default: Story = {
  render: () => <PaletteHarness />,
};
