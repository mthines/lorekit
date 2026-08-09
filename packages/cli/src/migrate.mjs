// `lorekit migrate --from <path> [--to home|project] [--yes|--apply]`
//
// Relocation / rename tool — NOT a persistent-memory importer. It reads a
// LoreKit-format local store at <path> (e.g. an old `.lore/` directory, or a
// store that was moved elsewhere) and re-writes its entries into the resolved
// current-layout store(s), so lessons are never stranded by a rename or a move.
//
// Dry-run (preview) by default: it prints what would move, per scope, and
// changes nothing. Only `--yes` (or `--apply`) mutates. Idempotent: entries are
// upserted verbatim by scope+key, so a re-run is all NOOP.
//
// Out of scope: reading persistent-memory's `~/.agent-memory/<bucket>/INDEX.md`
// + `entries/` format. This tool only understands LoreKit's own on-disk format.
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './config.mjs';
import { localStoreDirs } from './control.mjs';
import { createLocalStore, createTwoTierStore } from './store/index.mjs';
import { parseEntry } from './store/format.mjs';
import { seenCountOf } from './store/entry-fields.mjs';
import { log, heading, status, err, c } from './util.mjs';

// Recursively collect every parseable LoreKit entry under a base dir. The
// canonical scope comes from each file's frontmatter, so the source layout does
// not have to match the destination layout.
function collectEntries(base) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.md')) {
        try {
          const entry = parseEntry(fs.readFileSync(p, 'utf8'));
          if (entry && entry.scope && entry.key) out.push(entry);
        } catch {
          // Skip an unreadable / non-entry file rather than abort the migration.
        }
      }
    }
  };
  walk(base);
  return out;
}

// Full-field equality (ignoring nothing) so a re-run after apply is NOOP.
//
// `seen_count` is part of that equality, not an exception. `putEntry` relocates
// the count verbatim, so leaving it out of the comparison made a re-run whose
// ONLY difference was the tally land as `noop` — the destination kept its own
// count and the source's was silently dropped, contradicting the one thing
// `putEntry` promises. Read through `seenCountOf` rather than compared raw, so
// an entry written before the column existed (`null`) and one that carries an
// explicit `0` are the same "no evidence" and do not churn a `noop` into an
// `update` on every run.
function sameEntry(a, b) {
  if (!a || !b) return false;
  const norm = (e) =>
    JSON.stringify({
      tags: [...(e.tags || [])].sort(),
      source_agent: e.source_agent ?? null,
      trigger: e.trigger ?? null,
      created: e.created ?? null,
      updated: e.updated ?? null,
      archived_at: e.archived_at ?? null,
      seen_count: seenCountOf(e),
      value: e.value == null ? '' : String(e.value),
    });
  return norm(a) === norm(b);
}

export async function migrate(args) {
  const root = resolveProjectRoot(args.dir);

  const from = typeof args.from === 'string' ? args.from : null;
  if (!from) {
    err(`${c.red('migrate:')} --from <path> is required (the store to migrate from)`);
    return 1;
  }
  const src = path.isAbsolute(from) ? from : path.join(root, from);
  if (!fs.existsSync(src)) {
    err(`${c.red('migrate:')} source not found: ${src}`);
    return 1;
  }

  const to = typeof args.to === 'string' ? args.to.toLowerCase() : null;
  if (to && to !== 'home' && to !== 'project') {
    err(`${c.red('migrate:')} --to must be "home" or "project"`);
    return 1;
  }
  const apply = Boolean(args.apply || args.yes);

  const dirs = localStoreDirs(root);

  // Resolve where each entry goes. `--to` forces a single tier; the default
  // routes each entry by scope through the two-tier store (global → home,
  // repo/branch → project when opted-in, else home).
  let targetFor;
  let destLabel;
  if (to === 'home') {
    const store = createLocalStore(dirs.home);
    targetFor = () => store;
    destLabel = `home (${dirs.home})`;
  } else if (to === 'project') {
    if (apply) fs.mkdirSync(dirs.project, { recursive: true }); // opt-in on apply
    const store = createLocalStore(dirs.project);
    targetFor = () => store;
    destLabel = `project (${dirs.project})`;
  } else {
    const two = createTwoTierStore(dirs);
    targetFor = (scope) => two.tierFor(scope);
    destLabel = 'resolved layout (global→home, repo/branch→project-if-opted-in)';
  }

  const entries = collectEntries(src);

  heading('LoreKit migrate');
  log(`  from: ${c.dim(src)}`);
  log(`  to:   ${c.dim(destLabel)}`);
  log(`  mode: ${apply ? c.bold('apply') : 'dry-run — pass --yes to apply'}`);
  log(`  found: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);

  const totals = { add: 0, update: 0, noop: 0 };
  const byScope = new Map();
  for (const entry of entries) {
    const store = targetFor(entry.scope);
    const current = store.getEntry({ scope: entry.scope, key: entry.key });
    let verdict;
    if (!current) verdict = 'add';
    else if (sameEntry(current, entry)) verdict = 'noop';
    else verdict = 'update';

    totals[verdict]++;
    const s = byScope.get(entry.scope) || { add: 0, update: 0, noop: 0 };
    s[verdict]++;
    byScope.set(entry.scope, s);

    if (apply && verdict !== 'noop') await store.putEntry(entry);
  }

  for (const [scope, s] of byScope) {
    status('info', scope, `${s.add} add, ${s.update} update, ${s.noop} unchanged`);
  }

  const moved = totals.add + totals.update;
  heading('Summary');
  log(
    `  ${apply ? 'migrated' : 'would migrate'} ${moved} entr${moved === 1 ? 'y' : 'ies'} ` +
      `(${totals.add} new, ${totals.update} updated), ${totals.noop} unchanged.`,
  );
  if (!apply && moved > 0) log(`  ${c.dim('Re-run with --yes to apply.')}`);
  return 0;
}
