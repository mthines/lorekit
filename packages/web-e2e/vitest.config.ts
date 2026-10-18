import { defineConfig } from 'vitest/config';

// Vitest runs ONLY the browser-free half (`src/**/*.test.ts`): every spec in
// specs/*.md parses, every page in packages/web is visited by one, and the
// grammar + ui-verify import/export behave. It needs no browser and no
// server, so it rides the `check` job's `nx affected -t test` on every PR that
// touches packages/web or this package (see `implicitDependencies` in
// project.json). The browser tests are `*.e2e.ts` and belong to Playwright.
export default defineConfig({
  test: {
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
