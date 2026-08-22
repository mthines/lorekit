import type { Meta, StoryObj } from '@storybook/react';
import { GraduationCap, LayoutDashboard, BookOpen, Settings } from 'lucide-react';

import { CommandPaletteFab } from './CommandPaletteFab';
import { CommandPaletteProvider } from './CommandPaletteProvider';

/**
 * Visual-regression stories for the {@link CommandPaletteFab}.
 *
 * The FAB only makes sense in the geometry it was designed for — docked in the
 * centre of the mobile tab bar, half clear of the bar's top border — so the
 * harness reproduces that frame at a phone width (390px, iPhone 14 / Pixel
 * class) rather than snapshotting a floating disc on an empty canvas. The four
 * flanking tabs are STUBS, not the real `Sidebar`: what these baselines protect
 * is the disc (gradient, bevel, halo spread, docking offset) and its balance
 * against the tab column widths, and the real bar needs a Supabase `User` plus
 * the onboarding and router contexts to mount.
 *
 * The halo's `animate-halo-breathe` loop is frozen by the global
 * `animation-duration: 0s` override in `.storybook/preview.tsx`, so the
 * screenshot lands on the element's base opacity every run instead of a random
 * point in the 4.5s cycle.
 */

const STUB_TABS = [
  { label: 'Overview', icon: LayoutDashboard, active: true },
  { label: 'Explorer', icon: BookOpen, active: false },
  { label: 'Setup', icon: GraduationCap, active: false },
  { label: 'Settings', icon: Settings, active: false },
] as const;

type StubTab = (typeof STUB_TABS)[number];

function StubTabButton({ label, icon: Icon, active }: StubTab) {
  return (
    <span
      className={[
        'flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-1 px-0.5 text-[11px]',
        active ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-secondary)]',
      ].join(' ')}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <span className="max-w-full truncate">{label}</span>
    </span>
  );
}

/** A phone-width frame with the tab bar pinned to its bottom edge. */
function TabBarFrame() {
  return (
    <div className="relative h-[220px] w-[390px] overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)]">
      <nav className="absolute inset-x-0 bottom-0 flex border-t border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        {STUB_TABS.slice(0, 2).map((tab) => (
          <StubTabButton key={tab.label} {...tab} />
        ))}
        <div className="relative min-h-[3.5rem] flex-1">
          <CommandPaletteFab />
        </div>
        {STUB_TABS.slice(2).map((tab) => (
          <StubTabButton key={tab.label} {...tab} />
        ))}
      </nav>
    </div>
  );
}

const meta: Meta<typeof CommandPaletteFab> = {
  title: 'Command/CommandPaletteFab',
  component: CommandPaletteFab,
  decorators: [
    (Story) => (
      <CommandPaletteProvider>
        <Story />
      </CommandPaletteProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CommandPaletteFab>;

/**
 * The resting FAB docked in the tab bar: amber gradient face, top-edge bevel
 * highlight, breathing halo at its base opacity, and the four tabs holding even
 * columns either side of it.
 */
export const Default: Story = {
  render: () => <TabBarFrame />,
};
