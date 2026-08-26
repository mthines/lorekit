// `lorekit obligations` — check a changed-file set against the Surface-Partner
// Map (`../shared/obligations-map.mjs`) and print any partner surface a known
// partnership obliges that is NOT itself in the changed set ("you forgot to
// sweep X"), citing the memory lesson the partnership encodes.
//
// This is a machine version of a recurring `dash0-dev` review finding: a fix
// to one surface leaves its partner stale because the lessons documenting the
// partnership are retrieved lexically and rarely surface at edit time for the
// exact file just touched. Slice 1 is a standalone CLI check — no hook
// wiring, no server changes (see the plan's Out-of-scope section).
//
// Cwd-INDEPENDENT by design (`cli-bash-cwd-resets-to-repo-root-each-call`):
// it matches the path STRINGS it is given against the map; it never reads the
// filesystem or resolves scope from the current directory, so it works the
// same regardless of where it is invoked from as long as the paths given are
// repo-relative.
//
// Changed-set resolution — positionals and `--files` are UNIONED (so both a
// bare list and the flag form work together, and `--files a b c` composes
// naturally: the parser's single-value form takes `a` as the flag's value and
// leaves `b`/`c` as positionals); stdin is read only as a FALLBACK, when
// NEITHER produced anything — the same flag → positional → stdin precedence
// `write.mjs`'s value resolution uses. This is a deliberate narrowing from a
// flat three-way union: reading stdin unconditionally means every invocation
// that already named its files explicitly still blocks on stdin closing,
// which is surprising for a caller that piped nothing, and turns any
// in-process call (e.g. this command under `node:test`, invoked directly
// rather than spawned) into a hang, since the test runner's own stdin never
// reaches EOF. De-duplicated, first-seen order preserved.
//
//   1. positionals after the command token (`obligations <path> <path> …`)
//      unioned with `--files <path>`
//   2. stdin lines (trimmed, non-empty) — read ONLY when (1) is empty and
//      stdin is not a TTY
//
// Exit code: 0 by default; 1 when `--strict` is given AND any path obligation
// is unmet. `run:` obliges are advisory (`met: null`) and never gate.
import process from 'node:process';
import { log, heading, c } from '../shared/util.mjs';
import { checkObligations } from '../shared/obligations-pure.mjs';
import { SURFACE_PARTNER_MAP } from '../shared/obligations-map.mjs';

// Read stdin line-by-line, trimmed, non-empty. Resolves to [] when stdin IS a
// TTY (no pipe) — the same "no pipe, no read" convention `write.mjs` uses.
function readStdinLines() {
  if (process.stdin.isTTY) return Promise.resolve([]);
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
      const lines = Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(lines);
    });
    process.stdin.resume();
  });
}

// The resolved changed-set: (positionals ∪ --files), falling back to stdin
// only when that union is empty. De-duplicated, first-seen order preserved.
async function resolveChangedFiles(args) {
  const positionals = args._.slice(1).filter((p) => typeof p === 'string' && p);
  const flagged = typeof args.files === 'string' && args.files ? [args.files] : [];
  const named = dedupe([...positionals, ...flagged]);
  if (named.length > 0) return named;
  return dedupe(await readStdinLines());
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

export async function obligations(args) {
  const changedFiles = await resolveChangedFiles(args);
  const strict = Boolean(args.strict);
  const result = checkObligations({ changedFiles, map: SURFACE_PARTNER_MAP });

  if (args.json) {
    log(JSON.stringify({ ...result, strict }, null, 2));
  } else {
    render(result, changedFiles);
  }

  return {
    exitCode: strict && result.unmet > 0 ? 1 : 0,
    'lorekit.cli.obligations.files': changedFiles.length,
    'lorekit.cli.obligations.matched': result.matched.length,
    'lorekit.cli.obligations.unmet': result.unmet,
    'lorekit.cli.obligations.strict': strict,
  };
}

function render(result, changedFiles) {
  heading('LoreKit obligations');
  log(`  files: ${c.dim(changedFiles.length ? changedFiles.join(', ') : '(none given)')}`);

  if (result.matched.length === 0) {
    log('');
    log(`  ${c.dim('no known surface-partner obligations for the given changed-set')}`);
    log('');
    return;
  }

  for (const entry of result.matched) {
    log('');
    log(`  ${c.bold(entry.id)}${entry.guard ? c.dim(`  (guard: ${entry.guard})`) : ''}`);
    if (entry.note) log(`    ${c.dim(entry.note)}`);
    for (const o of entry.obliges) {
      const mark = o.kind === 'action' ? c.cyan('•') : o.met ? c.green('✓') : c.yellow('!');
      const suffix = o.kind === 'action' ? c.dim(' (advisory — run this yourself)') : '';
      log(`    ${mark} ${o.target}${suffix}`);
    }
    log(`    ${c.dim(`cites: ${entry.lessonKey}`)}`);
  }

  log('');
  if (result.unmet === 0) {
    log(`  ${c.green('✓')} every known path obligation is satisfied by the given changed-set`);
  } else {
    const plural = result.unmet === 1 ? '' : 's';
    log(`  ${c.yellow('!')} ${result.unmet} unmet obligation${plural} — sweep the partner${plural} above`);
  }
  log('');
}
