import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';

import { DuplicateClusters } from './DuplicateClusters';
import { memoryHandlers, FROZEN_NOW } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import { writePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import type { ClustersResponse, DuplicateCluster } from '@lorekit/schemas/memory';

/**
 * Visual-regression stories for the Explorer's Duplicate Clusters panel.
 *
 * They show it EXPANDED, which is not its default: the panel opens collapsed
 * (and while collapsed it deliberately issues no request at all), so a baseline
 * of the folded state would only ever pin the header. The disclosure itself —
 * including the "folded means not fetched" contract, which is the load-bearing
 * part — is covered by the interaction tests next door.
 *
 * `GET /memories/clusters` is mocked per story: the shared `memoryHandlers()`
 * fixture set has no near-duplicate bodies to cluster, and clustering real
 * fixtures in the mock would put a second implementation of the heuristic in the
 * browser, which is the one thing this feature must not have.
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
 * Seed the disclosure BEFORE the first paint.
 *
 * The component reads it through `useSyncExternalStore`, so writing it during
 * render (rather than clicking after it) is what makes the baseline capture a
 * settled state instead of racing an animated unfold.
 */
function Panel(props: { scopeLabel?: string }) {
  writePersistedPreference(PREFERENCE_KEYS.explorerClustersOpen, '1');
  return (
    <div style={{ maxWidth: 900 }}>
      <DuplicateClusters
        scope="repo::mthines/lorekit"
        scopeLabel={props.scopeLabel ?? 'repo::mthines/lorekit'}
        onOpenLesson={() => {}}
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

/** Three clusters — a pure class match (selected), a partial one, and an unclassed pair. */
export const Default: Story = {
  parameters: { msw: { handlers: [...memoryHandlers(), handler(response())] } },
  render: () => <Panel />,
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
  render: () => <Panel />,
};

/** No near-duplicates — the honest empty state, over a window that saw everything. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [...memoryHandlers(), handler(response({ candidates: 12, clusters: [] }))],
    },
  },
  render: () => <Panel />,
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
  render: () => <Panel />,
};
