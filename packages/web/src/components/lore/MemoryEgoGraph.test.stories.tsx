import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MemoryEgoGraph } from './MemoryEgoGraph';
import { NEIGHBOURS } from '@/mocks/memory-graph';

const onOpen = fn().mockName('onOpen');

const meta: Meta<typeof MemoryEgoGraph> = {
  title: 'Lore/MemoryEgoGraph/Tests',
  component: MemoryEgoGraph,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 480 }}><Story /></div>],
  args: { focusKey: 'tool-pitfalls::macos-sed-i-dash-E', neighbours: NEIGHBOURS.neighbours, onOpen },
  beforeEach: () => onOpen.mockClear(),
};

export default meta;
type Story = StoryObj<typeof MemoryEgoGraph>;

/** One node per neighbour, tagged with its kind. */
export const DrawsOneNodePerNeighbour: Story = {
  play: async ({ canvasElement }) => {
    const nodes = within(canvasElement).getAllByTestId('ego-node');
    await expect(nodes).toHaveLength(NEIGHBOURS.neighbours.length);
    await expect(nodes.map((n) => n.getAttribute('data-kind'))).toContain('duplicate');
  },
};

/** Hovering a node shows its key and why it is connected. */
export const HoverShowsReadout: Story = {
  play: async ({ canvasElement }) => {
    const [first] = within(canvasElement).getAllByTestId('ego-node');
    await userEvent.hover(first!);
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByText(/Credited in the same run/)).toBeVisible());
    await expect(body.getByText('5 shared runs', { exact: false })).toBeVisible();
  },
};

/** A mouse click opens the neighbour. */
export const ClickOpensNeighbour: Story = {
  play: async ({ canvasElement }) => {
    const [first] = within(canvasElement).getAllByTestId('ego-node');
    await userEvent.click(first!);
    await expect(onOpen).toHaveBeenCalledTimes(1);
    // strongest co-cited neighbour sits first on the ring
    await expect(onOpen.mock.calls[0]![0]).toMatchObject({ kind: 'co_cited', weight: 5 });
  },
};

/** Keyboard: arrow onto a node, Enter opens it. */
export const KeyboardOpens: Story = {
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group');
    group.focus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await expect(onOpen).toHaveBeenCalledTimes(1);
  },
};

/** Escape dismisses the readout. */
export const EscapeDismisses: Story = {
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group');
    group.focus();
    await userEvent.keyboard('{ArrowRight}');
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByText(/Click or press Enter to open/)).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByText(/Click or press Enter to open/)).toBeNull());
  },
};
