#!/usr/bin/env node
// Run the CLI smoke cases (cases.mjs) against the real `lorekit` binary.
//
//   node packages/cli/test/smoke/run.mjs                          # offline lane
//   node packages/cli/test/smoke/run.mjs --remote <endpoint> <token>
//   node packages/cli/test/smoke/run.mjs --remote "$URL" "$TOKEN" --only groom
//
// The offline lane needs nothing: a throwaway HOME and project, no network. It
// also runs on every PR inside `cli:test` (test/cli-smoke.test.mjs).
//
// The remote lane WRITES: every lesson goes under the run's own project scope
// (`project::cli-smoke-<runId>`) and is hard-deleted at the end, together with
// the retention policy it creates; anything it could not remove is named in the
// summary. It refuses the production project unless --allow-production is
// passed, matching the repo's rule that write-heavy smokes run against preview
// only (.github/workflows/deploy.yml).
//
// Exit code: 0 when every case passed or was skipped, 1 otherwise.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { CASES } from './cases.mjs';
import { PRODUCTION_REF, cleanupRemote, cliHelpers, createContext, disposeContext } from './harness.mjs';

/**
 * Run every case for one lane, in order. Never throws: returns the per-case
 * outcomes plus anything the remote cleanup could not remove.
 */
export async function runSmoke({ lane = 'offline', endpoint = null, token = null, only = null, log = () => {} } = {}) {
  const ctx = createContext({ lane, endpoint, token });
  const cli = cliHelpers(ctx);
  const results = [];
  try {
    for (const c of CASES) {
      if (!c.lanes.includes(lane)) continue;
      const label = `${c.command} — ${c.name}`;
      if (only && !label.includes(only)) continue;
      try {
        const skipped = await c.fn({ cli, ctx });
        if (typeof skipped === 'string') {
          results.push({ label, command: c.command, outcome: 'skip', detail: skipped });
          log(`  – ${label} (${skipped})`);
        } else {
          results.push({ label, command: c.command, outcome: 'pass' });
          log(`  ✓ ${label}`);
        }
      } catch (err) {
        results.push({ label, command: c.command, outcome: 'fail', detail: err.message });
        log(`  ✗ ${label}\n${String(err.message).replace(/^/gm, '      ')}`);
      }
    }
  } finally {
    var residue = await cleanupRemote(ctx).catch((err) => [`cleanup crashed: ${err.message}`]);
    disposeContext(ctx);
  }
  return { ctx: { lane, runId: ctx.runId, scope: ctx.scope }, results, residue };
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const remote = flags.has('--remote');
  const endpoint = remote ? (positional.find((p) => p !== only) ?? process.env.LOREKIT_MCP_URL) : null;
  const token = remote ? (positional.filter((p) => p !== only)[1] ?? process.env.LOREKIT_TOKEN) : null;

  const unknown = [...flags].filter((f) => !['--remote', '--allow-production', '--only'].includes(f));
  if (unknown.length) {
    console.error(`error: unknown option(s): ${unknown.join(', ')}`);
    return 2;
  }
  if (remote && (!endpoint || !token)) {
    console.error('usage: node packages/cli/test/smoke/run.mjs --remote <endpoint> <token> [--only <text>] [--allow-production]');
    return 2;
  }
  if (remote && endpoint.includes(PRODUCTION_REF) && !flags.has('--allow-production')) {
    console.error(`refusing to run against production (${PRODUCTION_REF}): the remote lane writes. Use the preview project.`);
    return 2;
  }

  const lane = remote ? 'remote' : 'offline';
  console.log(`CLI smoke — ${lane} lane${remote ? ` against ${new URL(endpoint).host}` : ''}`);
  const { ctx, results, residue } = await runSmoke({ lane, endpoint, token, only, log: (l) => console.log(l) });

  const count = (o) => results.filter((r) => r.outcome === o).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped — scope ${ctx.scope}`);
  if (residue.length) {
    console.log(`left behind (remove by hand):\n  ${residue.join('\n  ')}`);
  }
  return count('fail') > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
