// LoreKit CLI — durable telemetry identity.
//
// The CLI's own OTLP export (src/telemetry.mjs) was, by construction,
// unattributable: one span per command carrying the command name, a bounded
// flag allow-list and the runtime/OS tuple, and nothing that linked two runs.
// Server-side that gap does not exist — every authenticated REST/MCP call lands
// on an edge root span carrying `auth.user_id`, and `usage_events` records the
// same id — but a run that never leaves the machine (`--offline`, the two-tier
// local store, `lorekit hook`) makes no server call at all, so 1000 local spans
// could equally be one user or a thousand.
//
// This module closes that gap with TWO ids, because they answer different
// questions and neither substitutes for the other:
//
//   • installId — a random, opaque, locally-minted id, persisted so it survives
//     across runs. Always available once minted, including fully offline. It
//     differentiates INSTALLS: the same person on a laptop and in CI is two
//     ids, and two people sharing a container are one.
//
//   • accountId — the LoreKit account (Supabase auth UUID) the CLI last
//     authenticated as, learned from the `X-LoreKit-User-Id` response header
//     that `restFetch` reads off any authenticated call and cached here. Once
//     learned it is stamped on EVERY later run, offline ones included, which is
//     what makes local CLI usage joinable to server-side `auth.user_id` and
//     `usage_events.user_id`.
//
// PRIVACY — this runs on end-users' machines, so the invariants matter more
// than the feature:
//
//   1. Nothing is minted, and NO FILE IS EVER CREATED, while telemetry is
//      disabled. `ensureInstallId` takes the resolved config and returns null
//      when export is off, so an opt-out (LOREKIT_TELEMETRY=0, DO_NOT_TRACK=1,
//      `telemetry.disabled`) never gets a tracking id written to their disk.
//   2. `rememberAccountId` only ever UPDATES an existing file — it never
//      creates one. The file exists only where (1) already minted an install
//      id, so an opted-out user's account id is not recorded either, even
//      though the header is on every response they receive.
//   3. The install id is opaque and carries nothing derived from the machine —
//      no hostname, no MAC, no username, no path. It is random, so it says
//      "these runs are the same install" and nothing else about who that is.
//   4. It is a plain file the user owns and can inspect or delete; `doctor`
//      prints its location for exactly that reason. Deleting it resets the
//      install identity, which is the whole opt-out-after-the-fact story.
//
// Everything here is TOTAL: an unreadable file, an unwritable home, a corrupt
// JSON body and a full disk all degrade to "no identity" rather than throwing.
// Telemetry must never be the thing that breaks a command — the same contract
// `exportInvocation` holds.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { homeRoot } from './control.mjs';
import { writeFileAtomic } from './config.mjs';

/** Filename under the home tier. Sits beside `config.json` and the local store. */
const IDENTITY_FILE = 'telemetry-id.json';

/**
 * Absolute path to the identity file: `$LOREKIT_HOME/telemetry-id.json`,
 * defaulting to `~/.lorekit/telemetry-id.json`.
 *
 * Resolved through `homeRoot` — the SAME function that resolves the home-tier
 * store and `config.json` — rather than re-deriving `LOREKIT_HOME || ~/.lorekit`
 * here. A duplicated path resolution is not like the duplicated regexes
 * elsewhere in the zero-dep CLI: if the two drifted, the id would silently land
 * in a different directory than the store it belongs to, minting a "new install"
 * for a user who had one all along.
 *
 * @param {object} [env] defaults to process.env
 */
export function identityPath(env = process.env) {
  return path.join(homeRoot(env), IDENTITY_FILE);
}

/**
 * Read the stored identity, or an empty object. TOTAL — a missing file, an
 * unreadable one, a corrupt body, or a body that is valid JSON but not an
 * object all yield `{}`.
 *
 * The `typeof` guards are not defensive noise: `JSON.parse('null')`,
 * `JSON.parse('42')` and `JSON.parse('"x"')` all succeed, and a non-string
 * `installId` reaching an attribute bag would be emitted as `String(value)` —
 * so `{"installId": {}}` would ship the literal `[object Object]` as an
 * identity and quietly fold every such install into one bucket.
 *
 * @param {string} [file] defaults to {@link identityPath}
 * @returns {{ installId?: string, accountId?: string }}
 */
export function readIdentity(file = identityPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    if (typeof parsed.installId === 'string' && parsed.installId) out.installId = parsed.installId;
    if (typeof parsed.accountId === 'string' && parsed.accountId) out.accountId = parsed.accountId;
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist an identity object, creating the home directory if needed.
 * Returns true on success, false on any failure (unwritable home, full disk).
 *
 * @param {{ installId?: string, accountId?: string }} identity
 * @param {string} [file] defaults to {@link identityPath}
 */
function writeIdentity(identity, file = identityPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(identity, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint a fresh install id: 32 random hex characters.
 *
 * Deliberately opaque and machine-independent. A hostname- or MAC-derived id
 * would be stable without a file, but it would also be a fingerprint the user
 * cannot reset and one that leaks their machine into a span attribute.
 */
export function mintInstallId() {
  const b = new Uint8Array(16);
  // The WebCrypto global, as in telemetry.mjs — see the note there on why this
  // is used unqualified rather than imported from `node:crypto`.
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the install id, minting and persisting one on first use.
 *
 * Returns null — no identity, same as today's behaviour — when:
 *   • telemetry export is disabled (`config.enabled !== true`). This is the
 *     opt-out invariant: no id is minted and no file is created.
 *   • the id could not be persisted. An id that cannot be stored would be a
 *     DIFFERENT value on every run, which is strictly worse than none: it
 *     inflates the distinct-install count to equal the invocation count and is
 *     indistinguishable, in the data, from that many real installs. A read-only
 *     home therefore reports no identity rather than a misleading one.
 *
 * @param {{ enabled?: boolean }} config  the resolved telemetry config
 * @param {object} [opts]
 * @param {string} [opts.file] defaults to {@link identityPath}
 * @returns {string | null}
 */
export function ensureInstallId(config, { file = identityPath() } = {}) {
  // Delegates rather than repeating the mint-and-persist logic: two copies of
  // "read, mint if absent, preserve accountId, bail if unwritable" is two places
  // for the opt-out invariant to be broken independently.
  return ensureIdentity(config, { file }).installId;
}

/**
 * Resolve the full identity for a run — install id (minted on first use) plus
 * any cached account id — in ONE file read.
 *
 * The single entry point callers should use. `ensureInstallId` reads the file
 * and so did a follow-up `readIdentity()` for the account id, which put two
 * reads of the same small file on `lorekit hook`'s per-turn path for no reason.
 *
 * Same contract as {@link ensureInstallId}: nothing is minted and no file is
 * created while export is disabled, and a non-persistable id reports as no
 * identity rather than as a fresh one per run.
 *
 * @param {{ enabled?: boolean }} config  the resolved telemetry config
 * @param {object} [opts]
 * @param {string} [opts.file] defaults to {@link identityPath}
 * @returns {{ installId: string | null, accountId: string | null }}
 */
export function ensureIdentity(config, { file = identityPath() } = {}) {
  if (!config || config.enabled !== true) return { installId: null, accountId: null };
  const stored = readIdentity(file);
  const accountId = stored.accountId ?? null;
  if (stored.installId) return { installId: stored.installId, accountId };
  const installId = mintInstallId();
  // Preserve any accountId already cached — a corrupt-but-partial file should
  // not lose the account linkage on the run that repairs the install id.
  if (!writeIdentity({ ...stored, installId }, file)) return { installId: null, accountId: null };
  return { installId, accountId };
}

/**
 * Cache the LoreKit account id the CLI just authenticated as.
 *
 * Called from `restFetch` for every authenticated response that carries an
 * `X-LoreKit-User-Id` header — so the id is learned on any remote call and then
 * available to every later run, including offline ones.
 *
 * NEVER CREATES THE FILE. It writes only when a file with an install id already
 * exists, which is exactly the set of machines where telemetry was enabled and
 * minted one. That is what keeps an opted-out user's account id off their disk
 * without threading the telemetry config all the way into the HTTP layer.
 *
 * A no-op when the value is unchanged, so the common case is one read and no
 * write. Returns true only when something was actually persisted.
 *
 * @param {string | null | undefined} accountId
 * @param {object} [opts]
 * @param {string} [opts.file] defaults to {@link identityPath}
 */
export function rememberAccountId(accountId, { file = identityPath() } = {}) {
  if (typeof accountId !== 'string' || !accountId) return false;
  const stored = readIdentity(file);
  if (!stored.installId) return false; // no file / telemetry never enabled
  if (stored.accountId === accountId) return false;
  return writeIdentity({ ...stored, accountId }, file);
}

/**
 * The identity RESOURCE attribute, or `{}` when there is no identity.
 *
 * `service.instance.id` is the OTel semconv key for "which instance of this
 * service produced the telemetry", which is exactly what an install is — so the
 * install id belongs on the resource under the standard key rather than under a
 * `lorekit.*` one a backend has no built-in understanding of. Distinct installs
 * are then countable with no LoreKit-specific knowledge.
 *
 * @param {{ installId?: string | null }} identity
 */
export function identityResourceAttributes({ installId } = {}) {
  return installId ? { 'service.instance.id': installId } : {};
}

/**
 * The identity attribute for a CLI span / metric data point, or `{}` when there
 * is no identity to report.
 *
 * `user.id` is the ACCOUNT when one is known, else `install:<installId>`. This
 * mirrors the browser RUM decision (`web/src/lib/dash0-rum.ts`: an `anon:<uuid>`
 * upgraded in place to the real id), so a backend that folds `user.id` into
 * unique-user analytics answers "how many PEOPLE use the CLI" — collapsing one
 * person's laptop and CI runs into one user — while `service.instance.id` on the
 * resource still tells those installs apart underneath. The `install:` prefix
 * keeps a pre-auth run visibly distinct from a real account id instead of
 * silently occupying the same value space.
 *
 * CARDINALITY: this rides on the `lorekit.cli.invocations` counter as well as
 * the span, so the counter's series count is multiplied by the number of
 * distinct users. That is inherent to being able to differentiate them at all,
 * and it is bounded by real adoption rather than by anything a caller controls
 * — but it is the reason no FURTHER identity dimension belongs on the metric.
 *
 * @param {{ installId?: string | null, accountId?: string | null }} identity
 */
export function identityAttributes({ installId, accountId } = {}) {
  if (!installId) {
    // No install id means nothing was persisted (opted out, or unwritable
    // home). An accountId alone is not emitted: it can only have come from a
    // file that also holds an installId, so this branch means "no identity".
    return {};
  }
  return { 'user.id': accountId || `install:${installId}` };
}

/**
 * Read-only view of the identity for `doctor` to report: what is stored, where,
 * and whether an account has been linked yet. Never mints anything, so running
 * `doctor` cannot itself create the file.
 *
 * @param {object} [opts]
 * @param {string} [opts.file] defaults to {@link identityPath}
 */
export function describeIdentity({ file = identityPath() } = {}) {
  const stored = readIdentity(file);
  return {
    file,
    installId: stored.installId ?? null,
    accountId: stored.accountId ?? null,
  };
}
