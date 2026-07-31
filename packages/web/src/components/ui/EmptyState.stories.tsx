import type { Meta, StoryObj } from '@storybook/react';
import { Inbox, SearchX, FolderGit2 } from 'lucide-react';

import { EmptyState } from './EmptyState';

const meta: Meta<typeof EmptyState> = {
  title: 'UI/EmptyState',
  component: EmptyState,
  parameters: { layout: 'fullscreen' },
  args: {
    icon: Inbox,
    title: 'No lessons yet',
    description: 'Lessons your agents write will show up here.',
  },
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

/**
 * Visual-regression story: three representative empty states grouped into one
 * snapshot (default, search-miss, scoped).
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: '1rem', maxWidth: '32rem' }}>
      <EmptyState
        icon={Inbox}
        title="No lessons yet"
        description="Lessons your agents write will show up here."
      />
      <EmptyState
        icon={SearchX}
        title="No matches"
        description="No lessons match this search. Try a broader query."
      />
      <EmptyState
        icon={FolderGit2}
        title="No repository scopes"
        description="Connect a repo to start collecting scoped lore."
      />
    </div>
  ),
};

export const Playground: Story = {
  argTypes: {
    // `icon` is a component reference — not a serialisable control.
    icon: { control: false },
    title: { control: 'text' },
    description: { control: 'text' },
  },
};
