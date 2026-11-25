import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { MemoryEgoGraph } from './MemoryEgoGraph';
import { NEIGHBOURS, crowdedNeighbours } from '@/mocks/memory-graph';

/** Visual baselines for one lesson drawn at the centre of its neighbours. */
const meta: Meta<typeof MemoryEgoGraph> = {
  title: 'Lore/MemoryEgoGraph',
  component: MemoryEgoGraph,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 480 }}><Story /></div>],
  args: { focusKey: 'tool-pitfalls::macos-sed-i-dash-E', onOpen: fn() },
};

export default meta;
type Story = StoryObj<typeof MemoryEgoGraph>;

/** Every edge kind at once, with labels (few enough neighbours to name each). */
export const AllKinds: Story = { args: { neighbours: NEIGHBOURS.neighbours } };

/** Crowded: the second ring, no labels, and the cap. */
export const Crowded: Story = { args: { neighbours: crowdedNeighbours(30).neighbours } };
