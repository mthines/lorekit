#!/usr/bin/env node
/**
 * Migration-order guard (PR-time).
 *
 * Fails when a pull request ADDS a migration whose numeric prefix is <= the
 * highest migration already on the base branch — the exact mistake that wedges
 * the deploy: #260 shipped `00042`, then a parallel PR (#266) shipped `00041`,
 * which `supabase db push` then refused ("migration files to be inserted before
 * the last migration on remote"). Sequential integer prefixes have no defense
 * against parallel PRs each picking "the next number" from their own base; this
 * catches the collision at review time so it never reaches a deploy.
 *
 * It checks ADDED files only (never the already-merged history — the existing
 * out-of-order pair is grandfathered and handled by `db push --include-all`), so
 * it is not vacuous and does not fight legitimate high-numbered additions.
 *
 * NOTE the residual gap: two PRs that both branch from the same base and add the
 * same next number can each pass here and still collide once both merge, UNLESS
 * "require branches up to date before merging" is enabled on `main` (recommended
 * — it forces the second to rebase, at which point this guard fires). The
 * collision-proof end state is Supabase's timestamp filenames; this guard is the
 * cheap, no-rename interim.
 *
 *   node scripts/check-migration-order.mjs <base-ref>
 *   node scripts/check-migration-order.mjs origin/main
 *
 * Exit 0 = ok (or no migrations added); exit 1 = an out-of-order addition.
 */

import { execFileSync } from 'node:child_process';

const MIG_DIR = 'supabase/migrations';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** `.../00041_org_actor_override.sql` → 41; non-migration files → null. */
export function prefixOf(file) {
  const m = /(?:^|\/)(\d+)_[^/]*\.sql$/.exec(file);
  return m ? Number(m[1]) : null;
}

/** Highest migration number among a list of files (−1 when there are none). */
export function maxPrefix(files) {
  return files.reduce((max, f) => {
    const n = prefixOf(f);
    return n !== null && n > max ? n : max;
  }, -1);
}

/**
 * The pure core: which ADDED migrations sort at or below the base's max.
 * Returns [{ file, num }], empty when everything is in order.
 */
export function misordered(addedFiles, baseMax) {
  return addedFiles
    .map((file) => ({ file, num: prefixOf(file) }))
    .filter((e) => e.num !== null && e.num <= baseMax)
    .sort((a, b) => a.num - b.num);
}

// Run the git plumbing only when invoked as a script (not when imported by a test).
const invokedDirectly = process.argv[1] && /check-migration-order\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const base = process.argv[2] || process.env.MIGRATION_CHECK_BASE;
  if (!base) {
    process.stderr.write('usage: check-migration-order.mjs <base-ref>  (or set MIGRATION_CHECK_BASE)\n');
    process.exit(2);
  }

  const added = git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', MIG_DIR])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (added.length === 0) {
    process.stdout.write('migration-order: no new migrations in this change — ok\n');
    process.exit(0);
  }

  const baseFiles = git(['ls-tree', '-r', '--name-only', base, '--', MIG_DIR])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const baseMax = maxPrefix(baseFiles);

  const bad = misordered(added, baseMax);
  if (bad.length === 0) {
    process.stdout.write(
      `migration-order: ${added.length} new migration(s) all sort after the base max ` +
        `(${String(baseMax).padStart(5, '0')}) — ok\n`,
    );
    process.exit(0);
  }

  const next = String(baseMax + 1).padStart(5, '0');
  process.stderr.write(
    '::error::Out-of-order migration(s) detected. Renumber so each sorts AFTER the ' +
      `highest migration already on the base branch (${String(baseMax).padStart(5, '0')}):\n`,
  );
  for (const { file, num } of bad) {
    process.stderr.write(`  - ${file} (${String(num).padStart(5, '0')}) must be >= ${next}\n`);
  }
  process.stderr.write(
    'Rebase onto the base branch and renumber the file(s); `supabase db push` applies ' +
      'migrations in numeric order, so a lower number added after a higher one that is already ' +
      'live cannot be applied without --include-all and risks an order the tests never saw.\n',
  );
  process.exit(1);
}
