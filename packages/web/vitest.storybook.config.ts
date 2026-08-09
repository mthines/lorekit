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
  // Pre-bundle the deps the setup file and stories pull in so Vite doesn't
  // discover them mid-run and reload (which crashes the run on a COLD cache —
  // i.e. every CI run — with "Failed to fetch dynamically imported module" as
  // the optimized react shim is re-hashed out from under an in-flight import).
  // `react-dom` (via `createPortal`) and `motion/react` (drag/AnimatePresence)
  // both first enter the story graph through `BottomSheet`, so declare them
  // here alongside the setup-file deps. The `@lorekit/schemas` subpaths are
  // here because they are workspace-linked SOURCE: Vite walks into them, finds
  // their bare `zod` import and re-optimizes mid-run ("new dependencies found:
  // zod" → reload). Pre-bundling the subpath inlines zod, so a story that first
  // pulls a schema VALUE in (`FilterMenu.test.stories.tsx`) cannot trigger it.
  // Listing `zod` itself does NOT work — pnpm keeps it out of this package's
  // node_modules, so Vite fails to resolve it.
  optimizeDeps: {
    include: [
      '@storybook/nextjs-vite',
      'storybook/test',
      'react-dom',
      'motion/react',
      '@lorekit/schemas/memory',
      '@lorekit/schemas/tags',
    ],
  },
  test: {
    name: 'storybook',
    setupFiles: [path.join(storybookDir, 'vitest.setup.ts')],
    browser: {
      enabled: true,
      headless: true,
      // Pin the Playwright browser-CONTEXT viewport. The committed baselines are
      // 960x720 = the 1200x900 story iframe scaled by min(1, cw/1200, ch/900);
      // 0.8 = 720/900, i.e. Playwright's default 1280x720 context. Pinning it
      // makes that dependency explicit so a Playwright default change cannot
      // silently invalidate every baseline.
      //
      // NOTE this is the context viewport, NOT `instances[].viewport`: the latter
      // only sizes the test iframe, which @storybook/addon-vitest overwrites with
      // 1200x900 for every story, so pinning it there would not pin anything.
      provider: playwright({
        contextOptions: { viewport: { width: 1280, height: 720 } },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
