import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the TypeScript path alias from tsconfig.base.json so that
      // tests can import @lorekit/core from source (no build step needed).
      '@lorekit/core': path.resolve(__dirname, '../mcp-core/src/index.ts'),
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
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      reportsDirectory: '../../coverage/packages/mcp-server',
      provider: 'v8',
    },
  },
});
