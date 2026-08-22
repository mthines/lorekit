import { beforeAll, beforeEach, expect } from 'vitest';
import { page } from 'vitest/browser';
import { setProjectAnnotations } from '@storybook/nextjs-vite';
import type { StoryContext } from '@storybook/react';

import * as projectAnnotations from './preview';
import { PREFERENCE_KEYS } from '../src/lib/persisted-preference';

// ─────────────────────────────────────────────────────────────────────────────
// Storybook × Vitest setup — applies the preview annotations AND the
// visual-regression screenshot hook.
//
// The screenshot lives in a Storybook-level `afterEach` (a project annotation)
// on purpose: that hook runs INSIDE each story's test body, right after `play`,
// where `toMatchScreenshot` has the test context it needs. A plain Vitest
// `afterEach` runs after the test has ended and the browser matcher throws
// "cannot be used without test context".
//
// Interaction tests (`*.test.stories.tsx`, `/Tests` namespace) set
// `parameters.chromatic.disableSnapshot` — the same opt-out Chromatic honours —
// so they are skipped here. Every other story (Default / Playground) is a
// visual-regression target and is snapshotted, one baseline per story.
// ─────────────────────────────────────────────────────────────────────────────

async function visualRegression(context: StoryContext): Promise<void> {
  const chromatic = context.parameters?.['chromatic'] as
    | { disableSnapshot?: boolean }
    | undefined;
  if (chromatic?.disableSnapshot) return;

  const root = document.querySelector('#storybook-root') ?? document.body;

  // `toMatchScreenshot` reads `currentTestName` off the expect state to name the
  // baseline and refuses to run without it. This Storybook `afterEach` runs
  // inside the story's Vitest test, but the module `expect` doesn't inherit the
  // test name in the hook — so pin it to this story's name on every call (NOT
  // just when empty: the state leaks between stories, so a conditional set would
  // collide Playground onto Default's baseline).
  expect.setState({ currentTestName: context.name });

  await expect(page.elementLocator(root as Element)).toMatchScreenshot({
    comparatorName: 'pixelmatch',
    comparatorOptions: {
      // Tolerate a tiny fraction of differing pixels (font AA, glow blur).
      allowedMismatchedPixelRatio: 0.02,
      threshold: 0.2,
    },
  });
}

const project = setProjectAnnotations([
  projectAnnotations,
  { afterEach: visualRegression },
]);

beforeAll(project.beforeAll);

// ─────────────────────────────────────────────────────────────────────────────
// Persisted UI preferences are reset before EVERY story, globally.
//
// The suite runs every story file against ONE origin, so `localStorage` outlives
// a file: a story that switches the Explorer's Activity panel to its heatmap view
// would otherwise decide what a LATER file's baseline depicts — including files
// that know nothing about the preference (`LorePage.stories.tsx` renders the panel
// two levels down). That is a cross-file dependency on story order, and it fails
// as a mysterious pixel diff in an unrelated component.
//
// Global rather than a `beforeEach` in each affected story meta, because "each
// affected story" is not knowable: any story that renders a subtree containing a
// persisted preference is affected, and the list grows silently.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  for (const key of Object.values(PREFERENCE_KEYS)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // A blocked store means nothing persisted in the first place.
    }
  }
});
