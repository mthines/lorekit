#!/usr/bin/env node
/**
 * Typecheck every Supabase Edge Function with `deno check`, enforcing a
 * RATCHET: a function may not carry MORE type errors than its committed
 * baseline.
 *
 * Why a ratchet instead of a clean gate
 * ------------------------------------
 * `supabase/functions/**` was typechecked by NOTHING for the life of the
 * project — no `deno check` in any workflow, no covering tsconfig, no nx
 * target. The first run over it found real errors that predate this gate, and
 * they are not one thing: optional-handling gaps in `memories/handlers/`,
 * `never`-typed rows in `_shared/api/auth.ts` (which may mean the generated DB
 * types are stale), `.single()`-vs-array casts across the org handlers, and
 * postgrest version skew. Fixing them needs behavioural judgement per case.
 *
 * Blocking on zero would have meant either an unrelated cleanup inside whatever
 * PR happened to add the gate, or no gate. Neither is right, and "narrow the
 * gate to one function" does not work here: the errors live in `_shared/`
 * modules that every function imports.
 *
 * So: the existing debt is written down per function, and the gate fails the
 * moment a number goes UP. A regression is caught on the commit that introduces
 * it, the debt is visible and countable rather than folklore, and the numbers
 * can only be lowered. When one reaches 0 it stays there, because going back up
 * is exactly what this fails on.
 *
 * The baseline is a CEILING, never a target. A run that comes in UNDER its
 * baseline says so and tells you to commit the lower number.
 *
 * Usage:
 *   node scripts/deno-check-functions.mjs
 *
 * Requires `deno` on PATH. Node-only otherwise (no dependencies), so the CI job
 * needs no pnpm/Node setup step — the runner's own Node is enough.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(repoRoot, 'supabase/functions');
const baselinePath = join(repoRoot, 'supabase/deno-check-baseline.json');

/** The flags, stated once. Both this script's callers get the same resolution. */
export const DENO_CHECK_FLAGS = [
  // The repo root has a pnpm package.json, so Deno would otherwise switch to
  // node_modules resolution and fail on `npm:@supabase/supabase-js@2`, which is
  // not a root dependency and should not become one. The deployed edge runtime
  // resolves `npm:` from Deno's own cache with no node_modules; this matches it.
  '--node-modules-dir=none',
  // There is no deno.json / deno.lock — edge functions are deliberately
  // self-contained with `npm:` specifiers and no import map. Do not create one.
  '--no-lock',
];

/** Every function entrypoint, by function name. */
export function entrypoints(dir = functionsDir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => ({ fn: e.name, entry: `supabase/functions/${e.name}/index.ts` }))
    .filter(({ entry }) => existsSync(join(repoRoot, entry)))
    .sort((a, b) => a.fn.localeCompare(b.fn));
}

/**
 * Errors reported by a `deno check` run. Pure, so the parse is testable.
 *
 * Deno prints `Found N errors.` for a multi-error run but nothing countable for
 * a single one, so a failing run with no count means exactly 1.
 */
export function parseErrorCount(output, exitCode) {
  if (exitCode === 0) return 0;
  const found = /Found (\d+) errors?\./.exec(output);
  if (found) return Number(found[1]);
  return 1;
}

/** Compare actual counts to the baseline. Pure; returns a verdict per function. */
export function compare(actual, baseline) {
  const names = [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort();
  return names.map((fn) => {
    const now = actual[fn];
    const allowed = baseline[fn];
    if (now === undefined) return { fn, status: 'stale-baseline', now, allowed };
    if (allowed === undefined) return { fn, status: 'unlisted', now, allowed };
    if (now > allowed) return { fn, status: 'regressed', now, allowed };
    if (now < allowed) return { fn, status: 'improved', now, allowed };
    return { fn, status: 'unchanged', now, allowed };
  });
}

const group = (title) => (process.env.GITHUB_ACTIONS ? `::group::${title}` : `── ${title}`);
const endGroup = () => (process.env.GITHUB_ACTIONS ? '::endgroup::' : '');
const annotate = (message) => (process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`);

function main() {
  if (!existsSync(baselinePath)) {
    console.error(`Missing baseline: ${baselinePath}`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).functions;

  const actual = {};
  for (const { fn, entry } of entrypoints()) {
    console.log(group(`deno check ${fn}`));
    const res = spawnSync('deno', ['check', ...DENO_CHECK_FLAGS, entry], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (res.error) {
      console.error(`Could not run deno: ${res.error.message}`);
      process.exit(1);
    }
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    process.stdout.write(output);
    actual[fn] = parseErrorCount(output, res.status);
    console.log(endGroup());
  }

  const verdicts = compare(actual, baseline);
  const regressed = verdicts.filter((v) => v.status === 'regressed');
  const improved = verdicts.filter((v) => v.status === 'improved');
  const broken = verdicts.filter((v) => v.status === 'stale-baseline' || v.status === 'unlisted');

  const rows = verdicts.map((v) => {
    const mark = { regressed: '❌', improved: '⬇️', unchanged: '  ', 'stale-baseline': '⚠️', unlisted: '⚠️' }[v.status];
    return `| \`${v.fn}\` | ${v.now ?? '—'} | ${v.allowed ?? '—'} | ${mark} ${v.status} |`;
  });
  const summary = [
    '### Edge typecheck (ratchet)',
    '',
    '| Function | Errors | Baseline | |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  console.log(`\n${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    // Appended rather than written so a re-run does not clobber the section.
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    } catch { /* a summary is a nicety; never fail the gate over it */ }
  }

  for (const v of broken) {
    console.log(annotate(
      v.status === 'unlisted'
        ? `Function "${v.fn}" has no baseline entry. Add it to supabase/deno-check-baseline.json.`
        : `Baseline names "${v.fn}", which no longer exists. Remove it from supabase/deno-check-baseline.json.`,
    ));
  }
  for (const v of regressed) {
    console.log(annotate(
      `${v.fn}: ${v.now} type errors, baseline ${v.allowed}. `
      + 'This change ADDED errors — fix them rather than raising the baseline.',
    ));
  }
  if (improved.length) {
    console.log(
      `\n${improved.length} function(s) came in under baseline — commit the lower numbers:\n`
      + JSON.stringify({ functions: actual }, null, 2),
    );
  }

  if (regressed.length || broken.length) process.exit(1);
  console.log('Edge typecheck: no function exceeds its baseline.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
