#!/usr/bin/env node
/**
 * Measure `buildLoreGraph` at the free-plan memory ceiling.
 *
 * This exists because `docs/lore-graph.md` quotes a build time, and a design
 * contract that asks you to build against a number you cannot reproduce is
 * folklore. Run it and you get the figure the doc cites, on your hardware:
 *
 * ```bash
 * node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/bench-lore-graph.mjs
 * node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/bench-lore-graph.mjs --runs 9
 * ```
 *
 * The `--disable-warning` flag only silences a benign `MODULE_TYPELESS_PACKAGE_JSON`
 * notice about importing `.ts` from a package with no `"type"` field; drop it if
 * you would rather see it.
 *
 * It is deliberately NOT a test and gates nothing. A wall-clock assertion in
 * the suite is the one check that can go red on a noisy runner with no code
 * change, which trains everyone to re-run rather than to read — so the timing
 * lives here and `build.spec.ts` pins the bounded-output property instead.
 *
 * The synthetic account is shaped like a real one rather than uniformly random:
 * a few dozen key namespaces (the `<bucket>-lessons::` convention), a couple of
 * dozen repos, and a long tail of labels with two per memory. A uniform-random
 * dataset would produce almost no shared terms and measure the cheap path.
 */

import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';

// Import the REAL module rather than reimplementing the algorithm in JS — a
// benchmark measuring a copy is a benchmark of something that can drift from
// what ships. Two things stand in the way, both handled here with no new
// dependency: Node strips the TypeScript types itself (v22.18+), and the
// package's '@/' path alias is resolved by the hook below, which is the one
// piece of vitest/webpack config a plain 'node' invocation does not inherit.
const WEB_SRC = new URL('../packages/web/src/', import.meta.url);
const EXTENSIONLESS = /(?:^\.{1,2}\/|^@\/)[^?]*$/;
registerHooks({
  resolve(specifier, context, next) {
    // '@/x' -> <web>/src/x.ts (the package's tsconfig alias)
    if (specifier.startsWith('@/')) {
      return next(new URL(`${specifier.slice(2)}.ts`, WEB_SRC).href, context);
    }
    // './types' -> './types.ts'. TypeScript source omits the extension; Node's
    // ESM resolver requires it. Only extension-less relative specifiers are
    // touched, so nothing in node_modules is affected.
    if (EXTENSIONLESS.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};

const NODES = flag('nodes', 5_000);
const RUNS = flag('runs', 5);

const { buildLoreGraph } = await import(new URL('lib/lore-graph/build.ts', WEB_SRC).href);

const memories = Array.from({ length: NODES }, (_, i) => ({
  key: `bucket-${i % 100}::lesson-${i}`,
  scope: `repo::owner/repo-${i % 100}`,
  tags: [`t${i % 300}`, `t${i % 97}`],
  origin_repo: `owner/repo-${i % 100}`,
  updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 3600)).toISOString(),
}));

const timings = [];
let graph;
for (let run = 0; run < RUNS; run++) {
  const started = performance.now();
  graph = buildLoreGraph(memories);
  timings.push(performance.now() - started);
}

const sorted = [...timings].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const ms = (value) => `${value.toFixed(1)} ms`;

console.log(`buildLoreGraph — ${NODES.toLocaleString()} memories, ${RUNS} runs`);
console.log(`  node       ${process.version}`);
console.log(`  min/med/max ${ms(sorted[0])} / ${ms(median)} / ${ms(sorted[sorted.length - 1])}`);
console.log(`  nodes      ${graph.nodes.length.toLocaleString()}`);
console.log(`  edges      ${graph.edges.length.toLocaleString()}`);
console.log(
  `  truncated  ${graph.truncated.length === 0 ? 'none' : JSON.stringify(graph.truncated)}`,
);
