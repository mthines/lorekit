import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';

import { DuplicateClusters } from './DuplicateClusters';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import type { ClustersResponse } from '@lorekit/schemas/memory';

/**
 * Visual-regression stories for the Explorer's Duplicate Clusters TRIGGER bar.
 *
 * This is deliberately thin now: the trigger only ever shows its idle state or
 * a one-line summary badge once opened. The cluster LIST and its detail states
 * (loading/empty/failed/populated) live in `DuplicateClustersSidebar.stories.tsx`
 * — the sidebar that opening this trigger reveals — since that is where all of
 * that content actually renders.
 *
 * `GET /memories/clusters` is mocked per story: the shared `memoryHandlers()`
 * fixture set has no near-duplicate bodies to cluster, and clustering real
 * fixtures in the mock would put a second implementation of the heuristic in the
 * browser, which is the one thing this feature must not have.
 */

function response(over: Partial<ClustersResponse> = {}): ClustersResponse {
  return {
    threshold: 0.8,
    candidates: 64,
    candidate_limit: 150,
    clusters: [
      {
        size: 3,
        score: 42,
        min_similarity: 0.86,
        max_similarity: 0.97,
        recurrence_class: { id: 'edge-mirror-drift', name: 'Edge mirror drift', matched: ['a', 'b'], pure: true },
        members: [
          { scope: 'global', key: 'a', hook: 'First.', seen_count: 4, updated_at: FROZEN_NOW, status: null },
          { scope: 'global', key: 'b', hook: 'Second.', seen_count: 3, updated_at: FROZEN_NOW, status: null },
          { scope: 'global', key: 'c', hook: 'Third.', seen_count: 1, updated_at: FROZEN_NOW, status: null },
        ],
      },
      {
        size: 2,
        score: 5,
        min_similarity: 0.92,
        max_similarity: 0.92,
        recurrence_class: null,
        members: [
          { scope: 'global', key: 'd', hook: 'Fourth.', seen_count: 2, updated_at: FROZEN_NOW, status: null },
          { scope: 'global', key: 'e', hook: 'Fifth.', seen_count: 1, updated_at: FROZEN_NOW, status: null },
        ],
      },
    ],
    ...over,
  };
}

function handler(body: ClustersResponse) {
  return http.get('*/functions/v1/memories/clusters', () => HttpResponse.json(body));
}

function Trigger(props: { initialOpen?: boolean; scopeLabel?: string }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  return (
    <div style={{ maxWidth: 320 }}>
      <DuplicateClusters
        scope="repo::mthines/lorekit"
        scopeLabel={props.scopeLabel ?? 'repo::mthines/lorekit'}
        open={open}
        onToggleOpen={() => setOpen((value) => !value)}
      />
    </div>
  );
}

const meta: Meta<typeof DuplicateClusters> = {
  title: 'Lore/DuplicateClusters',
  component: DuplicateClusters,
  parameters: { layout: 'padded' },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClusters>;

/** Idle — closed, so no request has fired and there is nothing to summarize yet. */
export const Closed: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handler(response())] } },
  render: () => <Trigger initialOpen={false} />,
};

/** Open — the summary badge reports what the (now-visible) sidebar found. */
export const Open: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handler(response())] } },
  render: () => <Trigger initialOpen={true} />,
};

/** Open, with nothing to report — the badge says so rather than staying blank. */
export const OpenEmpty: Story = {
  parameters: {
    msw: { handlers: [...memoryHandlers(), handler(response({ candidates: 12, clusters: [] }))] },
  },
  render: () => <Trigger initialOpen={true} />,
};
