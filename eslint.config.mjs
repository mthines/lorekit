import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // @lorekit/cli is a standalone, zero-dependency Node package (no TS build);
    // it is verified by its own `node:test` suite, not the monorepo TS lint gate.
    // `plugins/` and `scripts/` are template bundles and tooling, not app code.
    ignores: ['**/dist', '**/node_modules', 'packages/cli/**', 'plugins/**', 'scripts/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cj]?mjs$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
];
