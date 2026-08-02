#!/usr/bin/env node
/**
 * Remote-migration-drift classifier (deploy-time).
 *
 * `preview` is a SHARED Supabase project. Two workflows push migrations to it:
 *
 *   • deploy.yml  — on every merge to `main`
 *   • preview.yml — on a `/preview` comment, from an OPEN PR's head SHA
 *
 * So the preview remote can legitimately carry migration versions that do not
 * exist on `main` yet: a `/preview` run on PR #311 applied 00049/00050/00051 to
 * the shared project, and the next `main` deploy died with
 *
 *   Remote migration versions not found in local migrations directory.
 *   supabase migration repair --status reverted 00049 00050 00051
 *
 * even though `main` had NOTHING left to apply — every one of its 00001–00048
 * was already on the remote (the PR branch contains all of them). `supabase db
 * push` treats a remote that is merely AHEAD as fatal, so a green deploy was
 * blocked by a consistency check rather than by pending work.
 *
 * This module classifies that drift so the workflow can react proportionally:
 *
 *   push  — remote carries nothing unknown; run `supabase db push` as usual.
 *   skip  — remote is only AHEAD (unknown versions, zero local pending). The
 *           push would be a provable no-op, so skip it and warn. The unknown
 *           versions reconcile on their own when the PR that introduced them
 *           merges and its files land in supabase/migrations.
 *   fail  — remote carries unknown versions AND local has pending migrations.
 *           Genuinely ambiguous (the pending files may collide with what the
 *           preview run already applied) — stop and make a human decide.
 *
 * `skip` is deliberately the ONLY tolerant outcome, and it is safe by
 * construction: with zero local-pending migrations there is no work a
 * successful `db push` would have done that skipping omits.
 *
 * Usage — pipe `supabase migration list --linked` output in on stdin:
 *
 *   supabase migration list --linked | node scripts/check-remote-migration-drift.mjs
 *
 * Writes `action`, `remote_only` and `local_pending` to $GITHUB_OUTPUT when set.
 * Exit 0 for `push` / `skip`; exit 1 for `fail`.
 */

/** Strip ANSI colour escapes the Supabase CLI emits when it thinks it has a TTY. */
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Parse the version table `supabase migration list --linked` prints. The CLI
 * wraps each version in BACKTICKS and prints THREE columns (Local | Remote |
 * Time), e.g.
 *
 *      Local   | Remote  | Time (UTC)
 *      --------|---------|--------------------
 *      `00048` | `00048` | `00048`
 *      ` `     | `00049` | `00049`
 *
 * (older CLI builds printed bare digits in two columns — both are handled). Each
 * cell is stripped of backticks and whitespace, then only cells that are
 * ENTIRELY digits count as versions, so the header row, the separator, the third
 * column, and the CLI's chatter ("Connecting to remote database...") are all
 * ignored without needing to be recognised. Only cells[0] (Local) and cells[1]
 * (Remote) are read. Returns `{ local: string[], remote: string[] }` preserving
 * on-screen order.
 *
 * NOTE: this backtick handling is why the deploy that first shipped the
 * classifier still failed — the real listing is backticked, the original parser
 * matched only bare digits, so it saw an EMPTY table and mis-chose `push`.
 */
export function parseMigrationList(stdout) {
  const local = [];
  const remote = [];
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(ANSI, '');
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.replace(/`/g, '').trim());
    if (/^\d+$/.test(cells[0])) local.push(cells[0]);
    if (cells.length > 1 && /^\d+$/.test(cells[1])) remote.push(cells[1]);
  }
  return { local, remote };
}

/**
 * The pure decision core. Returns `{ action, localPending, remoteOnly }` where
 * action is one of 'push' | 'skip' | 'fail'.
 *
 * Fail-safe on an unparseable listing: an empty `local` means we could not read
 * the table (CLI error, format change), and we must never SKIP on a guess — the
 * outcome is `push`, which restores the previous behaviour exactly, including
 * its error message.
 */
export function classifyDrift({ local = [], remote = [] } = {}) {
  const remoteSet = new Set(remote);
  const localSet = new Set(local);
  const localPending = local.filter((v) => !remoteSet.has(v));
  const remoteOnly = remote.filter((v) => !localSet.has(v));

  if (remoteOnly.length === 0) return { action: 'push', localPending, remoteOnly };
  if (local.length === 0) return { action: 'push', localPending, remoteOnly };
  if (localPending.length === 0) return { action: 'skip', localPending, remoteOnly };
  return { action: 'fail', localPending, remoteOnly };
}

/** Human-readable annotation for a classification. Pure — returned, not printed. */
export function annotate({ action, localPending, remoteOnly }) {
  if (action === 'push') {
    // `classifyDrift` has TWO push paths. The second is the fail-safe: no local
    // versions were parsed, so we push to restore the previous behaviour exactly
    // — and `remoteOnly` is non-empty there. Claiming a clean remote in that case
    // is false at the one moment the operator has least to go on.
    if (remoteOnly.length > 0) {
      return (
        `::warning::migration-drift: no local migration versions were parsed from ` +
        `\`supabase migration list\` (a CLI error, or a change to its table format), ` +
        `while the remote reports ${remoteOnly.join(', ')}. The drift is therefore ` +
        `unverifiable, and skipping on a guess is never allowed — falling back to ` +
        `\`supabase db push\`, which restores the previous behaviour exactly, ` +
        `including its error message.`
      );
    }
    return `migration-drift: no unknown versions on the remote — pushing ${localPending.length} pending migration(s).`;
  }
  if (action === 'skip') {
    return (
      `::warning::migration-drift: the shared preview database is AHEAD of this ref by ` +
      `${remoteOnly.join(', ')} — almost certainly applied by a \`/preview\` run on an open PR ` +
      `(preview.yml pushes migrations from a PR head SHA to the same project). Nothing is ` +
      `pending locally, so the push would be a no-op and is skipped; these versions reconcile ` +
      `when that PR merges. Nothing was applied and nothing was repaired.`
    );
  }
  return (
    `::error::migration-drift: the shared preview database carries ${remoteOnly.join(', ')}, ` +
    `which are NOT in supabase/migrations on this ref, AND this ref has pending migration(s) ` +
    `${localPending.join(', ')} to apply. That is ambiguous — the pending file(s) may collide ` +
    `with what an open PR's \`/preview\` run already applied. Resolve by merging the PR that ` +
    `owns ${remoteOnly.join(', ')}, or (if those changes were abandoned) reverting them on the ` +
    `preview project and running ` +
    `\`supabase migration repair --status reverted ${remoteOnly.join(' ')}\`.`
  );
}

// Run the stdin/exit plumbing only when invoked as a script (not when imported by a test).
const invokedDirectly =
  process.argv[1] && /check-remote-migration-drift\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = classifyDrift(parseMigrationList(Buffer.concat(chunks).toString('utf8')));

  const message = annotate(result);
  (result.action === 'fail' ? process.stderr : process.stdout).write(`${message}\n`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `action=${result.action}\n` +
        `remote_only=${result.remoteOnly.join(' ')}\n` +
        `local_pending=${result.localPending.join(' ')}\n`,
    );
  }

  process.exit(result.action === 'fail' ? 1 : 0);
}
