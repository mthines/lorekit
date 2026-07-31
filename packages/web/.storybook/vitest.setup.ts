import { beforeAll, expect } from 'vitest';
import { page } from 'vitest/browser';
import { setProjectAnnotations } from '@storybook/nextjs-vite';
import type { StoryContext } from '@storybook/react';

import * as projectAnnotations from './preview';

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
