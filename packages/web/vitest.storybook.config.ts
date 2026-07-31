import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

// ─────────────────────────────────────────────────────────────────────────────
// Storybook × Vitest (browser mode) — the `test-storybook` NX target.
//
// This config is DELIBERATELY separate from `vitest.config.ts` (the node/jsdom
// unit target) because it runs stories in a real browser via Playwright. Only
// the dedicated CI `web-test` job invokes it; the ordinary `check` job's
// `nx test` never touches a browser.
//
// It runs BOTH test kinds the two-file convention produces, in one browser run:
//   • Interaction tests — the `play` functions in `*.test.stories.tsx`
//     (`/Tests` namespace) are executed by `@storybook/addon-vitest`.
//   • Visual regression  — the `afterEach` hook in `.storybook/vitest.setup.ts`
//     screenshots every OTHER story (the Default / Playground visual stories)
//     and diffs it against the committed baseline.
//
// The `setupFiles` entry below (`.storybook/vitest.setup.ts`) applies the
// preview annotations (the dark-surface decorator in `.storybook/preview.tsx`)
// via `setProjectAnnotations` AND registers the visual-regression `afterEach`
// hook — the hook is why the setup file is required, not optional.
// ─────────────────────────────────────────────────────────────────────────────

const dirname = path.dirname(fileURLToPath(import.meta.url));
const storybookDir = path.join(dirname, '.storybook');

export default defineConfig({
  // `storybookTest` is async (returns Promise<Plugin[]>); Vite resolves a plugin
  // promise natively, so no top-level await / async factory is needed.
  plugins: [storybookTest({ configDir: storybookDir })],
  resolve: {
    alias: { '@': path.resolve(dirname, 'src') },
  },
  // Pre-bundle the deps the setup file pulls in so Vite doesn't discover them
  // mid-run and reload (which crashes the run on a COLD cache — i.e. every CI
  // run). Without this, the first invocation flakes with "Vite unexpectedly
  // reloaded a test".
  optimizeDeps: {
    include: ['@storybook/nextjs-vite', 'storybook/test'],
  },
  test: {
    name: 'storybook',
    setupFiles: [path.join(storybookDir, 'vitest.setup.ts')],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
