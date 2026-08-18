import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { LoreGraphView } from './LoreGraphView';
import {
  archivedAccount,
  awkwardLabels,
  hubHeavyAccount,
  oneGiantScope,
  realisticAccount,
  singleMemory,
  unrelatedMemories,
} from '@/lib/lore-graph/story-fixtures';
import { planCeilingMemories } from '@/lib/lore-graph/fixtures';
import type { GraphMemoryInput } from '@/lib/lore-graph/build';

/**
 * The 3D memory map, across the data shapes that change what it draws.
 *
 * ## Why these stories are not snapshotted
 *
 * Every story here sets `chromatic.disableSnapshot`, which is also the opt-out
 * `.storybook/vitest.setup.ts` honours. A WebGL frame depends on the GPU, the
 * driver and the ANGLE backend, so a committed baseline would compare
 * like-for-unlike and flake for reasons that have nothing to do with the change
 * under test. Everything that CAN be pinned deterministically is pinned in Node
 * instead — the graph model, the layout, the GPU buffer contents, the palette
 * mirror and the notice copy are covered by ~100 specs.
 *
 * These stories exist for the other job a story does: letting a human look at
 * the thing, including in the states a healthy account never produces.
 *
 * ## Why one story per scenario, rather than grouped variants
 *
 * The house pattern groups variants into a single `Default` story so visual
 * regression takes one snapshot per file. That rationale does not survive here
 * — there is no snapshot — and following it anyway would be actively harmful:
 * each `<Canvas>` acquires its own WebGL context, browsers cap live contexts at
 * roughly 8–16, and past the cap they silently evict the oldest. Eight scenarios
 * in one render tree is a page of blank canvases.
 *
 * ## Determinism
 *
 * The fixtures are seeded and the timestamps are frozen (`STORY_NOW`), so the
 * same story draws the same constellation on every load. That is not decoration:
 * the layout's core claim is that a memory's position is a hash of its identity,
 * and the only way to see that is for the identities to be stable.
 */
const meta: Meta<typeof LoreGraphView> = {
  title: 'Lore/LoreGraphView',
  component: LoreGraphView,
  parameters: {
    layout: 'padded',
    chromatic: { disableSnapshot: true },
  },
  args: {
    selectedId: null,
    hasMore: false,
  },
};

export default meta;
type Story = StoryObj<typeof LoreGraphView>;

/**
 * Selection is stateful in the real page (the Explorer opens a detail sheet and
 * passes the open memory's id back down), so the stories model it rather than
 * passing a dead `onSelect`. Without this, clicking a node in Storybook would
 * do nothing and the selection ring would be unreachable.
 */
function SelectableMap({ memories, hasMore }: { memories: GraphMemoryInput[]; hasMore?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <LoreGraphView
      memories={memories}
      selectedId={selectedId}
      hasMore={hasMore ?? false}
      onSelect={(nodeId) => setSelectedId((current) => (current === nodeId ? null : nodeId))}
    />
  );
}

/**
 * What a working agent fleet looks like: a few hundred memories over six
 * scopes, clustered by scope, tied together by shared labels and key
 * namespaces. This is the story to open first.
 */
export const Default: Story = {
  render: () => <SelectableMap memories={realisticAccount()} />,
};

/**
 * The plan ceiling — 5,000 memories, the most the free tier can hold.
 *
 * Deliberately included despite being slow to build (~420 ms on the reference
 * machine, on the main thread — see `docs/lore-graph.md`). The point of the
 * story is exactly that: it is the one place you can feel the cost before a
 * customer does.
 */
export const PlanCeiling: Story = {
  name: 'Plan ceiling (5,000 memories)',
  // Excluded from the automated browser run by `tags.exclude` in
  // `vitest.storybook.config.ts`. Mounting it costs a ~400 ms graph build plus
  // 5,100 instanced nodes and 50,000 line vertices rasterised by SwiftShader on
  // a GPU-less CI runner — a slow test that proves nothing `Default` does not.
  // It stays fully browsable; it just is not a gate.
  tags: ['stress'],
  render: () => <SelectableMap memories={planCeilingMemories()} />,
};

/**
 * Nothing loaded. The map explains what it would draw rather than showing an
 * empty void, because an empty 3D scene is indistinguishable from a broken one.
 */
export const Empty: Story = {
  render: () => <SelectableMap memories={[]} />,
};

/** One memory. The degenerate layout — a single node beside its scope. */
export const SingleMemory: Story = {
  render: () => <SelectableMap memories={singleMemory()} />,
};

/**
 * Memories with nothing in common: no shared label, key namespace or repo.
 *
 * Every node hangs off its scope by the skeleton alone and not one relationship
 * line is drawn. A legitimate picture that must not read as a rendering bug.
 */
export const NoRelationships: Story = {
  render: () => <SelectableMap memories={unrelatedMemories()} />,
};

/**
 * Every memory carrying the same three labels, so hub suppression removes all
 * of them.
 *
 * The map looks identical to `NoRelationships` — and means the opposite. The
 * coverage notice is the only thing that tells them apart, which is why it is
 * not optional decoration.
 */
export const EverythingShareOneLabel: Story = {
  name: 'Hub-suppressed labels',
  render: () => <SelectableMap memories={hubHeavyAccount()} />,
};

/** One scope holding everything — a single dense ball rather than a constellation. */
export const OneGiantScope: Story = {
  render: () => <SelectableMap memories={oneGiantScope()} />,
};

/**
 * Every memory archived: the whole graph dimmed.
 *
 * The check here is that dimming kept the scope HUE — an archived repo memory
 * should still read as a repo memory — rather than greying everything to one
 * slate.
 */
export const AllArchived: Story = {
  render: () => <SelectableMap memories={archivedAccount()} />,
};

/**
 * A 100-character key, a branch scope nobody would choose, CJK, an emoji, RTL
 * text, and a one-character key.
 *
 * The hover read-out and the legend render these untruncated; this is where you
 * find out whether they clip, wrap, or push the panel off its container.
 */
export const AwkwardLabels: Story = {
  render: () => <SelectableMap memories={awkwardLabels()} />,
};

/**
 * The Explorer has more pages it has not fetched.
 *
 * The map is drawing a subset and says so — the failure this notice exists to
 * prevent is a complete-looking picture of half an account.
 */
export const PartiallyLoaded: Story = {
  render: () => <SelectableMap memories={realisticAccount({ count: 60 })} hasMore />,
};

/**
 * Interactive knobs over the FIXTURE, not over the component's props.
 *
 * A `Playground` whose controls were `memories` / `selectedId` / `onSelect`
 * would be a JSON textarea and two dead fields — useless. What a developer
 * actually wants to vary is the shape of the account, because that is what
 * changes the picture: cluster count, density, how much is archived, whether a
 * hub label is present. The component under test is unchanged; only the data
 * feeding it is parameterised.
 */
export const Playground: Story = {
  argTypes: {
    // The real props are driven by the harness below, so they are hidden rather
    // than shown as controls that do nothing.
    memories: { table: { disable: true } },
    selectedId: { table: { disable: true } },
    onSelect: { table: { disable: true } },
  },
  args: {
    // Harness knobs. Declared through `args` so Storybook renders controls for
    // them; consumed by `render`, not forwarded to the component.
    ...({
      count: 240,
      scopes: 6,
      archivedShare: 0.08,
      recurringShare: 0.25,
      withHubLabel: false,
      hasMore: false,
    } as Record<string, unknown>),
  },
  render: (args) => {
    const knobs = args as unknown as {
      count: number;
      scopes: number;
      archivedShare: number;
      recurringShare: number;
      withHubLabel: boolean;
      hasMore: boolean;
    };
    return (
      <SelectableMap
        memories={realisticAccount({
          count: knobs.count,
          scopes: knobs.scopes,
          archivedShare: knobs.archivedShare,
          recurringShare: knobs.recurringShare,
          withHubLabel: knobs.withHubLabel,
        })}
        hasMore={knobs.hasMore}
      />
    );
  },
};
