import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Archive, BookOpen, Clock, GitBranch } from 'lucide-react';

import { Combobox, type ComboboxItem } from './Combobox';

/**
 * Visual-regression stories for the shared single-select popup list.
 *
 * These fix the RESTING states — the trigger at each width and with each shape
 * of option. The popup itself is portaled and interaction-driven, so it is
 * covered by `Combobox.test.stories.tsx`; screenshotting an open popover would
 * pin a position that depends on where the trigger happened to land.
 */
const meta: Meta<typeof Combobox> = {
  title: 'UI/Combobox',
  component: Combobox,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof Combobox>;

const STATUS: ComboboxItem[] = [
  { value: 'active', label: 'Active', hint: 'Live memories', icon: BookOpen },
  { value: 'archived', label: 'Archived', hint: 'Archived memories', icon: Archive },
  { value: 'expiring', label: 'Expiring', hint: 'Live memories expiring within 7 days', icon: Clock },
];

const BRANCHES: ComboboxItem[] = [
  { value: 'main', label: 'main', icon: GitBranch },
  { value: 'feat/explorer-filters', label: 'feat/explorer-filters', icon: GitBranch },
  { value: 'feat/maintenance', label: 'feat/maintenance', icon: GitBranch },
  { value: 'chore/deps', label: 'chore/deps', icon: GitBranch, disabled: true },
];

function Controlled({
  options,
  initial,
  ...rest
}: { options: ComboboxItem[]; initial: string } & Partial<
  Omit<Parameters<typeof Combobox>[0], 'options' | 'value' | 'onChange'>
>) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      options={options}
      value={value}
      onChange={setValue}
      label={rest.label ?? 'Status'}
      {...rest}
    />
  );
}

/**
 * The three shapes side by side: labelled, icon-only (the phone toolbar), and a
 * searchable list with a disabled option.
 *
 * Rendered together rather than as three stories because what is worth
 * eyeballing is that they read as the SAME control at different densities — a
 * separate screenshot each would hide a drift in height or border.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
      <Controlled options={STATUS} initial="active" label="Status" />
      <Controlled options={STATUS} initial="expiring" label="Status" compact />
      <Controlled
        options={BRANCHES}
        initial="main"
        label="Branch"
        searchable
        searchPlaceholder="Search branches…"
      />
    </div>
  ),
};
