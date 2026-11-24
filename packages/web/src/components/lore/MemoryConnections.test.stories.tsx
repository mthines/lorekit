import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MemoryConnections } from './MemoryConnections';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withFlagVariants, withFrozenClock, withMemorySidebar, withQueryClient } from '@/mocks/decorators';
import { EMPTY_NEIGHBOURS, FOCUS_ID, NEIGHBOURS, neighboursHandler } from '@/mocks/memory-graph';
import type { LessonEntry } from './LessonCard';

const LESSON: LessonEntry = {
  id: FOCUS_ID,
  scope: 'global',
  key: 'tool-pitfalls::macos-sed-i-dash-E',
  value: 'On macOS `sed -i -E` takes `-E` as the backup suffix.',
  tags: [],
  created_at: FROZEN_NOW,
  updated_at: FROZEN_NOW,
  scope_type: 'global',
};

const called = fn().mockName('neighboursRoute');

const meta: Meta<typeof MemoryConnections> = {
  title: 'Lore/MemoryConnections/Tests',
  component: MemoryConnections,
  tags: ['test'],
  args: { lesson: LESSON },
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    // `MemorySidebarProvider` keeps the open lesson in the URL (`useUrlState`), which needs the app router mounted.
    nextjs: { appDirectory: true },
    msw: { handlers: [...memoryHandlers(), neighboursHandler(NEIGHBOURS, called)] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withFlagVariants({ 'memory-graph': 'on' }), withMemorySidebar, withQueryClient],
  beforeEach: () => called.mockClear(),
};

export default meta;
type Story = StoryObj<typeof MemoryConnections>;

/** Folded means NOT FETCHED — the disclosure is what keeps the read off every drawer open. */
export const FoldedDoesNotFetch: Story = {
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole('button', { name: /connections/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await new Promise((r) => setTimeout(r, 150));
    await expect(called).not.toHaveBeenCalled();
  },
};

/** Opening fetches, then groups neighbours by kind and lists the runs. */
export const OpensAndGroupsByKind: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /connections/i }));
    await waitFor(() => expect(c.getByText('Used together')).toBeVisible());
    await expect(called).toHaveBeenCalledTimes(1);
    await expect(c.getByText('Credited by')).toBeVisible();
    await expect(c.getByText('Replaces')).toBeVisible();
    await expect(c.getByText('Near-duplicate')).toBeVisible();
    await expect(c.getByText('tool-pitfalls::zsh-echo-equals-separator')).toBeVisible();
    await expect(c.getByText('5×')).toBeVisible();
    await expect(c.getByText('91%')).toBeVisible();
    await expect(c.getByText('Credited in 2 runs')).toBeVisible();
    await expect(c.getByText('pr:mthines/lorekit#712')).toBeVisible();
  },
};

/** The section is a toggle: a second click folds it again. */
export const TogglesClosed: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const toggle = c.getByRole('button', { name: /connections/i });
    await userEvent.click(toggle);
    await waitFor(() => expect(c.getByText('Used together')).toBeVisible());
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(c.queryByText('Used together')).toBeNull();
  },
};

/** No edges is information: the empty state says why and how to get some. */
export const EmptyExplainsItself: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), neighboursHandler(EMPTY_NEIGHBOURS)] } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /connections/i }));
    await waitFor(() => expect(c.getByText(/No connections yet/)).toBeVisible());
  },
};

/** Flag off: the section does not exist and nothing is requested. */
export const FlagOffRendersNothing: Story = {
  decorators: [withFlagVariants({ 'memory-graph': 'off' })],
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: /connections/i })).toBeNull();
    await expect(called).not.toHaveBeenCalled();
  },
};

/** A lesson with no row id (legacy fetch) cannot be queried, so it shows no section. */
export const NoIdRendersNothing: Story = {
  args: { lesson: { ...LESSON, id: undefined } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: /connections/i })).toBeNull();
  },
};
