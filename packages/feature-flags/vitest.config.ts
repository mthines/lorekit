import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      reportsDirectory: '../../coverage/packages/feature-flags',
      provider: 'v8',
    },
  },
});
