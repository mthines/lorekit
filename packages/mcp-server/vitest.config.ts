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
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      reportsDirectory: '../../coverage/packages/mcp-server',
      provider: 'v8',
    },
  },
});
