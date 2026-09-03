// Unit tests for the canonical web-preview path filter.
//
// Three things are under test, and the second and third are the point:
//   1. The path table — what does and does not spend a Vercel deployment.
//   2. `grep -E` / JS `RegExp` agreement — the filter is ONE string consumed by
//      two engines, and the `$` anchors inside the alternation are the part that
//      could plausibly differ between them.
//   3. YAML parity — both workflow copies equal the canonical string, so drift
//      is a red test rather than a preview that silently stops (or never stops)
//      deploying.
//
// Run: node --test scripts/web-preview-filter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WEB_PREVIEW_PATH_FILTER,
  matchesWebPreviewPath,
  anyWebPreviewPath,
} from './web-preview-filter.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Every path either deploys a preview or does not; there is no third answer, so
// one table drives both the behaviour tests and the grep-parity sweep.
const CASES = [
  // ── The dashboard and what compiles into it ────────────────────────────────
  ['packages/web/src/app/(dashboard)/lore/LorePage.tsx', true],
  ['packages/web/package.json', true],
  ['packages/web/public/llms.txt', true],
  ['packages/schemas/src/shared/tool-catalog.ts', true],
  ['package.json', true],
  ['nx.json', true],

  // ── The preview machinery itself ───────────────────────────────────────────
  ['.github/actions/vercel-preview-deploy/action.yml', true],
  ['.github/workflows/web-preview.yml', true],
  ['.github/workflows/web-preview-deploy.yml', true],
  // The sticky comment's renderer — its output is what outside tooling scrapes,
  // and only a real deploy renders it. Its test file is not machinery.
  ['scripts/ci/web-preview-comment.mjs', true],
  ['scripts/ci/web-preview-comment.test.mjs', false],

  // ── Deliberately excluded: quota, not correctness ──────────────────────────
  // ci.yml is the regression this filter exists to fix — see the "unrelated CI
  // edit" test below.
  ['.github/workflows/ci.yml', false],
  ['.github/workflows/deploy.yml', false],
  ['pnpm-lock.yaml', false],

  // ── Other packages: a dashboard preview tells you nothing about these ──────
  ['packages/cli/package.json', false],
  ['packages/cli/src/commands.mjs', false],
  ['packages/mcp-core/src/scope/scope.ts', false],
  ['packages/smoke-tests/src/smoke.integration.spec.ts', false],
  ['supabase/functions/mcp/index.ts', false],
  ['supabase/migrations/00071_example.sql', false],
  ['scripts/sweep-telemetry.test.mjs', false],
  ['docs/deployment.md', false],
  ['CLAUDE.md', false],

  // ── Anchoring: a prefix match here would be a false positive ───────────────
  ['package.json.bak', false],
  ['nx.json.tmp', false],
  ['.github/workflows/web-preview-deploy.yml.orig', false],
  ['other/packages/web/index.tsx', false],
  // `packages/web/` needs the slash — `packages/webhooks/` is a different thing.
  ['packages/webhooks/src/index.ts', false],
];

test('the path table decides preview deployments as documented', () => {
  for (const [path, expected] of CASES) {
    assert.equal(
      matchesWebPreviewPath(path),
      expected,
      `${path} should ${expected ? 'deploy' : 'NOT deploy'} a preview`,
    );
  }
});

test('an unrelated CI edit deploys no preview (mthines/lorekit#528)', () => {
  // The exact file set of that PR: a new unit-test step in ci.yml plus docs and
  // a manual benchmark script. It deployed a preview because ci.yml used to be
  // in this filter.
  const pr528 = [
    '.github/workflows/ci.yml',
    'CLAUDE.md',
    'docs/README.md',
    'docs/benchmarking.md',
    'docs/limits.md',
    'docs/otel.md',
    'scripts/sweep-rows.mjs',
    'scripts/sweep-telemetry.mjs',
    'scripts/sweep-telemetry.test.mjs',
    'supabase/project.json',
    'supabase/tests/row-scaling-sweep.sql',
  ];
  assert.equal(anyWebPreviewPath(pr528), false);
});

test('a real dashboard change still deploys a preview', () => {
  assert.equal(
    anyWebPreviewPath(['docs/deployment.md', 'packages/web/src/lib/filters.ts']),
    true,
  );
});

test('`grep -E` and JS `RegExp` agree on every case', () => {
  for (const [path, expected] of CASES) {
    const { status, error } = spawnSync('grep', ['-qE', WEB_PREVIEW_PATH_FILTER], {
      input: `${path}\n`,
    });
    assert.equal(error, undefined, `grep failed to run: ${error?.message}`);
    assert.equal(
      status === 0,
      expected,
      `grep -E disagrees with the JS RegExp on ${path} — the filter must behave ` +
        'identically in both, since ci.yml greps with it and github-script builds ' +
        'a RegExp from it',
    );
  }
});

test('the filter is embeddable verbatim in single-quoted YAML and shell', () => {
  assert.ok(
    !WEB_PREVIEW_PATH_FILTER.includes("'"),
    'a single quote would break both YAML copies, which wrap it in single quotes',
  );
});

test("web-preview-deploy.yml's `web-path-filter` default is the canonical filter", () => {
  const yaml = readFileSync(join(repoRoot, '.github/workflows/web-preview-deploy.yml'), 'utf8');
  const match = yaml.match(/web-path-filter:[\s\S]*?\n\s*default:\s*'([^']*)'/);
  assert.ok(match, 'could not find the `web-path-filter` input default');
  assert.equal(
    match[1],
    WEB_PREVIEW_PATH_FILTER,
    'the reusable workflow drifted from scripts/ci/web-preview-filter.mjs',
  );
});

test("ci.yml's `web_preview` gate greps with the canonical filter", () => {
  const yaml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const patterns = [...yaml.matchAll(/grep -qE '([^']+)'/g)].map((m) => m[1]);
  const hits = patterns.filter((p) => p === WEB_PREVIEW_PATH_FILTER);
  assert.equal(
    hits.length,
    1,
    'expected exactly one grep in ci.yml to use the canonical preview filter ' +
      `(found ${hits.length}); the \`changes\` job drifted from ` +
      'scripts/web-preview-filter.mjs',
  );
});
