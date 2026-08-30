import nx from "@nx/eslint-plugin";

export default [
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    // @lorekit/cli is a standalone, zero-dependency Node package (no TS build);
    // it is verified by its own `node:test` suite, not the monorepo TS lint gate.
    // @lorekit/evals is the same shape for the same reason — a pure-`.mjs`
    // `node:test` package. Without this entry `@nx/eslint/plugin` infers a
    // `lint` target for it (verified with `nx show project evals`) and the CI
    // gate lints a package that has no TS config to lint against.
    // `plugins/` and `scripts/` are template bundles and tooling, not app code.
    ignores: [
      "**/dist",
      "**/node_modules",
      "packages/cli/**",
      "packages/evals/**",
      "plugins/**",
      "scripts/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: ["^.*/eslint(\\.base)?\\.config\\.[cj]?mjs$"],
          depConstraints: [
            {
              sourceTag: "*",
              onlyDependOnLibsWithTags: ["*"],
            },
          ],
        },
      ],
    },
  },
];
