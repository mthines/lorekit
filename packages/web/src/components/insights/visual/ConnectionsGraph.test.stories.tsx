import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ConnectionsGraph } from './ConnectionsGraph';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withFlagVariants, withFrozenClock, withMemorySidebar, withQueryClient } from '@/mocks/decorators';
import { EMPTY_GRAPH, GRAPH, graphHandler } from '@/mocks/memory-graph';

const called = fn().mockName('graphRoute');

const meta: Meta<typeof ConnectionsGraph> = {
  title: 'Insights/ConnectionsGraph/Tests',
  component: ConnectionsGraph,
  tags: ['test'],
  args: { since: '2026-06-08T12:00:00.000Z', rangeCaption: 'the last 7 days' },
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    // `MemorySidebarProvider` keeps the open lesson in the URL (`useUrlState`), which needs the app router mounted.
    nextjs: { appDirectory: true },
    msw: { handlers: [...memoryHandlers(), graphHandler(GRAPH, called)] },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withFlagVariants({ 'memory-graph': 'on' }), withMemorySidebar, withQueryClient],
  beforeEach: () => called.mockClear(),
};

export default meta;
type Story = StoryObj<typeof ConnectionsGraph>;

/** Every lesson is a node, orphans included, and the request carries the page window. */
export const DrawsEveryNode: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getAllByTestId('graph-node')).toHaveLength(GRAPH.nodes.length));
    await expect(called).toHaveBeenCalledTimes(1);
    await expect(c.getAllByTestId('graph-node').filter((n) => n.hasAttribute('data-orphan'))).toHaveLength(2);
  },
};

/** The hubs lens ranks by degree — the most-connected lesson first. */
export const HubsRankByDegree: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole('radio', { name: /hubs/i })).toBeChecked());
    const rows = await c.findAllByRole('button', { name: /links/i });
    await expect(rows[0]).toHaveTextContent('tool-pitfalls::zsh-echo');
    await expect(rows[0]).toHaveTextContent('4 links');
  },
};

/** Switching to orphans lists the read-but-unused lessons, most-read first. */
export const OrphansLens: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole('radio', { name: /orphans/i }));
    await expect(c.getByRole('radio', { name: /orphans/i })).toBeChecked();
    const rows = await c.findAllByRole('button', { name: /read \d+×/ });
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent('old::unused-note-a');
    await expect(rows[0]).toHaveTextContent('read 31×');
  },
};

/** Clusters groups connected lessons: two components here (five linked, and a pair). */
export const ClustersLens: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole('radio', { name: /clusters/i }));
    await expect(await c.findByText('5 lessons')).toBeVisible();
    await expect(c.getByText('2 lessons')).toBeVisible();
  },
};

/** An empty window explains how edges arise instead of drawing an empty canvas. */
export const EmptyExplains: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), graphHandler(EMPTY_GRAPH)] } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/No lessons were credited together/)).toBeVisible();
  },
};

/** A failed load is said out loud, not drawn as an empty graph. */
export const ErrorIsAlert: Story = {
  parameters: {
    msw: { handlers: [...memoryHandlers(), http.get('*/functions/v1/memories/graph', () => HttpResponse.json({ error: 'boom' }, { status: 500 }))] },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(/Could not load the connections graph/);
  },
};

/** Flag off: neither the heading nor the request exists. */
export const FlagOffRendersNothing: Story = {
  decorators: [withFlagVariants({ 'memory-graph': 'off' })],
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('heading', { name: /connections/i })).toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    await expect(called).not.toHaveBeenCalled();
  },
};
