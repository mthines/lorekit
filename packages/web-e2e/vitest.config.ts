import { defineConfig } from 'vitest/config';

// Vitest runs ONLY the coverage guard (`src/**/*.test.ts`) — the static check
// that every page in packages/web has an entry in src/routes.ts. It needs no
// browser and no server, so it rides the `check` job's `nx affected -t test`
// on every PR that touches packages/web (see `implicitDependencies` in
// project.json). The browser specs are `*.e2e.ts` and belong to Playwright.
export default defineConfig({
  test: {
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
