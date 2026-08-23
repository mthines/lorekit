import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // In GitHub Actions, add the `github-actions` reporter alongside the
    // default one so each failing test emits a typed `::error file=…,line=…::`
    // annotation — surfaced at the top of the run and via the checks API, so a
    // failure is readable without expanding logs. No-op locally.
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      reportsDirectory: '../../coverage/packages/smoke-tests',
      provider: 'v8',
    },
  },
});
