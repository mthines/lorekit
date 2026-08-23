// `lorekit purge` / `lorekit purge-expired` — the two maintenance sweeps.
//
//   purge [--retention-days N]   permanently delete archived lore older than N days
//   purge-expired                permanently delete TTL-expired lore
//
// Both are IRREVERSIBLE and account-wide: they carry no scope, and the row set
// is chosen inside the RPC rather than by anything the caller passes. Three
// consequences shape this module.
//
// 1. REMOTE ONLY. These sweep server-side state; the offline `.lorekit/` store
//    has no equivalent operation. `--local` is refused explicitly rather than
//    silently succeeding against a store it cannot affect.
//
// 2. NO DRY RUN IS POSSIBLE. The purge RPCs return their count only AFTER
//    deleting, and the REST dry-run header stops before the write and returns
//    nothing previewable — so "would purge N" cannot be answered honestly. The
//    gate is therefore a confirmation, not a preview: prompt on an interactive
//    terminal, and REQUIRE `--yes` when there is nobody to ask (a pipe, CI, or
//    `--json`). An agent loop must not be able to trigger one by omission.
//
// 3. A SCOPED KEY IS REFUSED BY THE SERVER, and that refusal is passed through
//    verbatim. `_shared/account-wide-tools.ts` refuses these two operations for
//    any token carrying a scope allowlist — a key narrowed to one repo has no
//    business sweeping the whole account. The CLI makes exactly one request and
//    reports the server's answer; it never retries, never splits the sweep and
//    never re-scopes to work around it.
import { resolveProjectRoot } from '../shared/config.mjs';
import { loadControl, resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { log, err, c, select } from '../shared/util.mjs';
import { PURGE_RETENTION_DAYS_DEFAULT } from '../surfaces.generated.mjs';

/** The window `retention_days` accepts, mirroring `PurgeMemoriesBodySchema`. */
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 365;

export { PURGE_RETENTION_DAYS_DEFAULT };

/**
 * Validate `--retention-days` before any request goes out.
 *
 * Client-side on purpose: the server would answer an out-of-range value with a
 * schema 4xx, and paying a round trip to be told "365 is the maximum" is a
 * worse experience than being told immediately. Pure, so the boundaries are
 * directly testable.
 */
export function parseRetentionDays(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { days: PURGE_RETENTION_DAYS_DEFAULT };
  }
  // Reject `12abc` and `1.5` rather than coercing: a value only half understood
  // is a value the caller did not mean.
  if (!/^\d+$/.test(String(raw).trim())) {
    return { error: `--retention-days must be a whole number, got ${JSON.stringify(String(raw))}` };
  }
  const days = Number(String(raw).trim());
  if (days < RETENTION_DAYS_MIN || days > RETENTION_DAYS_MAX) {
    return { error: `--retention-days must be between ${RETENTION_DAYS_MIN} and ${RETENTION_DAYS_MAX}, got ${days}` };
  }
  return { days };
}

/**
 * Decide how to gate an irreversible sweep.
 *
 * `proceed` — the caller said `--yes`.
 * `prompt`  — a human is present, so ask.
 * `refuse`  — nobody is present to ask and consent was not given. Refusing is
 *             the only safe answer: defaulting to yes would let an unattended
 *             agent loop purge, and defaulting to no while reporting success
 *             would lie about what happened.
 *
 * `--json` counts as non-interactive even on a TTY: its caller is a script
 * parsing stdout, and a prompt would corrupt that stream.
 */
export function confirmationDecision({ yes, json, isTTY }) {
  if (yes) return 'proceed';
  if (json || !isTTY) return 'refuse';
  return 'prompt';
}

/**
 * Render a failed sweep.
 *
 * A 403 is almost always the account-wide refusal for a scoped key, and the
 * server's own sentence explains it better than any translation — so it is
 * printed VERBATIM and only a next step is added. Collapsing it into a generic
 * "purge failed" is what would leave someone re-running the command with the
 * same key, which is the one thing that cannot work.
 */
export function describeFailure({ error, httpStatus, networkError } = {}) {
  if (networkError) return { message: networkError, hint: null };
  const message = error?.message ?? error ?? 'the server rejected the request';
  if (httpStatus === 403) {
    return {
      message: String(message),
      hint: 'Maintenance sweeps need an UNSCOPED token — a key restricted to specific scopes is refused for account-wide operations.',
    };
  }
  if (httpStatus === 429) {
    return { message: String(message), hint: 'Rate limited. Wait for the window to reset and run it again.' };
  }
  return { message: String(message), hint: null };
}

/** Resolve the remote store, or explain why there isn't one. */
function pickRemote({ root, env, args }) {
  if (args.local) {
    return {
      error:
        'purge is a remote maintenance operation — it sweeps server-side lore, '
        + 'and the offline store has no equivalent. Drop --local to run it against the API.',
    };
  }
  const { remoteDenied } = resolveDenies(root, { env });
  const { remote, connection } = resolveStores(root, { env, endpoint: args.endpoint, token: args.token });
  if (remoteDenied) return { error: `remote store is disabled by deny constraint (${remoteDenied.source})` };
  if (!remote.usable()) return { error: `remote store is not configured — ${remoteUnavailableReason(connection)}` };
  return { store: remote };
}

// One implementation for both verbs; `op` selects the store method, the label
// and whether `--retention-days` applies.
async function run(args, op) {
  const root = resolveProjectRoot(args.dir);
  const env = process.env;
  loadControl(root, { env });

  const retention = op === 'purge' ? parseRetentionDays(args['retention-days']) : { days: null };
  if (retention.error) {
    err(`${c.red('Error:')} ${retention.error}`);
    return 1;
  }

  const picked = pickRemote({ root, env, args });
  if (picked.error) {
    err(`${c.red('Error:')} ${picked.error}`);
    return 1;
  }

  const what = op === 'purge'
    ? `archived lore older than ${retention.days} day${retention.days === 1 ? '' : 's'}`
    : 'all TTL-expired lore';

  const decision = confirmationDecision({ yes: args.yes, json: args.json, isTTY: Boolean(process.stdin.isTTY) });
  if (decision === 'refuse') {
    err(`${c.red('Refusing:')} ${op} permanently deletes ${what} and cannot be undone.`);
    err(`Re-run with ${c.cyan('--yes')} to confirm. (Required when there is no terminal to prompt.)`);
    return 1;
  }
  if (decision === 'prompt') {
    const go = await select(
      `${c.bold('Permanently delete')} ${what}? This cannot be undone.`,
      [
        { value: false, label: 'Cancel', hint: 'nothing is deleted' },
        { value: true, label: `Yes, ${op}`, hint: 'irreversible' },
      ],
      { defaultIndex: 0 },
    );
    if (!go) {
      log(`${c.dim('Cancelled — nothing was deleted.')}`);
      return 0;
    }
  }

  const res = op === 'purge'
    ? await picked.store.purge({ retentionDays: retention.days })
    : await picked.store.purgeExpired();

  if (!res?.ok) {
    const { message, hint } = describeFailure(res);
    if (args.json) {
      log(JSON.stringify({ ok: false, op, purged: null, error: message, httpStatus: res?.httpStatus ?? null }, null, 2));
      return 1;
    }
    err(`${c.red('Error:')} ${message}`);
    if (hint) err(hint);
    return 1;
  }

  if (args.json) {
    log(JSON.stringify({ ok: true, op, purged: res.purged ?? 0, error: null }, null, 2));
    return 0;
  }
  const n = res.purged ?? 0;
  log(`${c.green('✓')} purged ${c.cyan(String(n))} ${n === 1 ? 'memory' : 'memories'} ${c.dim('(remote)')}`);
  return 0;
}

export function purge(args) { return run(args, 'purge'); }
export function purgeExpired(args) { return run(args, 'purge-expired'); }
