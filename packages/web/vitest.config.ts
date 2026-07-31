import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    // In GitHub Actions, add the `github-actions` reporter alongside the
    // default one so each failing test emits a typed `::error file=…,line=…::`
    // annotation — surfaced at the top of the run and via the checks API, so a
    // failure is readable without expanding logs. No-op locally.
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    // Default: node environment for pure-logic specs.
    // Hook and component specs override this per-file with
    // `// @vitest-environment jsdom` at the top of the file.
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    coverage: {
      reportsDirectory: '../../coverage/packages/web',
      provider: 'v8',
    },
  },
});
