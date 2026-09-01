import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { fn } from 'storybook/test';

import { DuplicateClustersSidebar } from './DuplicateClustersSidebar';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import type { ClustersResponse, DuplicateCluster } from '@lorekit/schemas/memory';

/**
 * Visual-regression stories for the Explorer's Duplicate Clusters sidebar body.
 *
 * `GET /memories/clusters` is mocked per story: the shared `memoryHandlers()`
 * fixture set has no near-duplicate bodies to cluster, and clustering real
 * fixtures in the mock would put a second implementation of the heuristic in the
 * browser, which is the one thing this feature must not have.
 *
 * The trigger bar's own folded/summary states live in `DuplicateClusters.stories.tsx` —
 * this component only ever mounts while open, so there is no collapsed state here.
 */

function member(scope: string, key: string, hook: string, seen: number, status: string | null = null) {
  return { scope, key, hook, seen_count: seen, updated_at: FROZEN_NOW, status };
}

/** Pure class match — every member resolves to one known recurrence. */
const PURE: DuplicateCluster = {
  size: 3,
  score: 42,
  min_similarity: 0.86,
  max_similarity: 0.97,
  recurrence_class: {
    id: 'edge-mirror-drift',
    name: 'Edge mirror drift',
    matched: ['edge-mirror-parity', 'mirror-pairs-registration', 'shared-module-mirrored-to-edge'],
    pure: true,
  },
  members: [
    member('repo::mthines/lorekit', 'edge-mirror-parity', 'A pure module added to mcp-core needs its `_shared/` twin in the SAME commit — edge-parity byte-compares them.', 9),
    member('repo::mthines/lorekit', 'mirror-pairs-registration', 'A new mirror pair is invisible to the drift guard until it is listed in mirror-pairs.mjs.', 4),
    member('global', 'shared-module-mirrored-to-edge', 'Deno cannot cross-import a workspace package, so shared logic is mirrored verbatim rather than imported.', 3, 'superseded'),
  ],
};

/** Partial match — the majority resolve, one member is something else. */
const PARTIAL: DuplicateCluster = {
  size: 3,
  score: 18,
  min_similarity: 0.81,
  max_similarity: 0.88,
  recurrence_class: {
    id: 'sandbox-install',
    name: 'Sandbox install is incomplete',
    matched: ['pnpm-install-first', 'nx-not-found'],
    pure: false,
  },
  members: [
    member('global', 'pnpm-install-first', 'Run `pnpm install` before the first `pnpm nx` command in a fresh container.', 6),
    member('global', 'nx-not-found', 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL "nx not found" is a missing install, not a broken nx config.', 5),
    member('project::lorekit-web', 'playwright-pinned', 'Playwright is pinned to 1.56.0 so pixel baselines compare like-for-like.', 2),
  ],
};

/** No class at all — near-duplicates nobody has named yet. */
const UNCLASSED: DuplicateCluster = {
  size: 2,
  score: 5,
  min_similarity: 0.92,
  max_similarity: 0.92,
  recurrence_class: null,
  members: [
    member('repo::mthines/lorekit', 'scope-filter-is-the-question', 'An ungrammatical ?scope= is a 400, never an empty page dressed up as "nothing here".', 3),
    member('repo::mthines/lorekit', 'bad-scope-filter-400', 'Filtering by a scope is the question itself, so a bad value fails loud.', 2),
  ],
};

function response(over: Partial<ClustersResponse> = {}): ClustersResponse {
  return {
    threshold: 0.8,
    candidates: 64,
    candidate_limit: 150,
    clusters: [PURE, PARTIAL, UNCLASSED],
    ...over,
  };
}

function handler(body: ClustersResponse) {
  return http.get('*/functions/v1/memories/clusters', () => HttpResponse.json(body));
}

/**
 * A recorded no-op for the selection hand-off — these are screenshot stories,
 * so nothing asserts on it, but a spy states "deliberately inert here" and
 * keeps the prop visible in the Storybook Actions panel.
 */
const onSelectCluster = fn().mockName('onSelectCluster');
const onClose = fn().mockName('onClose');

function Sidebar(props: { scopeLabel?: string; selectedClusterId?: string | null }) {
  return (
    <div style={{ maxWidth: 320 }}>
      <DuplicateClustersSidebar
        scope="repo::mthines/lorekit"
        scopeLabel={props.scopeLabel ?? 'repo::mthines/lorekit'}
        selectedClusterId={props.selectedClusterId ?? null}
        onSelectCluster={onSelectCluster}
        onClose={onClose}
      />
    </div>
  );
}

const meta: Meta<typeof DuplicateClustersSidebar> = {
  title: 'Lore/DuplicateClustersSidebar',
  component: DuplicateClustersSidebar,
  parameters: { layout: 'padded' },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof DuplicateClustersSidebar>;

/** Three clusters — a pure class match, a partial one, and an unclassed pair. */
export const Default: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handler(response())] } },
  render: () => <Sidebar />,
};

/**
 * The SATURATED window: the clustering ran against a full candidate cap, so the
 * footnote says which question it answered and points at `lorekit dedupe` for
 * the whole store.
 */
export const SaturatedWindow: Story = {
  parameters: {
    msw: { handlers: [...memoryHandlers(), handler(response({ candidates: 150 }))] },
  },
  render: () => <Sidebar />,
};

/** No near-duplicates — the honest empty state, over a window that saw everything. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [...memoryHandlers(), handler(response({ candidates: 12, clusters: [] }))],
    },
  },
  render: () => <Sidebar />,
};

/** The request failed — never folded into the empty state, which reads as a clean account. */
export const Failed: Story = {
  parameters: {
    msw: {
      handlers: [
        ...memoryHandlers(),
        http.get('*/functions/v1/memories/clusters', () =>
          HttpResponse.json({ error: 'Internal error' }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <Sidebar />,
};
