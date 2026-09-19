// SessionStart skill-update drift nudge: a terse, throttled line telling the
// agent "your skills are stale, run `lorekit update`" — computed entirely
// offline (see ../shared/skill-versions.mjs) and gated by `updates.notify`
// (../shared/control.mjs).
//
// Throttle state lives at `$LOREKIT_HOME/update-state.json`, following the
// exact precedent `telemetry/telemetry-identity.mjs` sets for a small,
// user-owned JSON file under the home tier: TOTAL reads (a missing/corrupt
// file degrades to `{}`, never throws), atomic writes via
// `shared/config.mjs`'s `writeFileAtomic`, and the file is written ONLY when
// there is something to record — never merely because this ran.
//
// The nudge fires at most once per NEW shipped-version signature, plus a
// 7-day cooldown on repeating that same signature. `updates.notify: off`
// short-circuits before any filesystem check runs, so an opted-out user's
// disk is never touched by this module at all.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homeRoot } from '../shared/control.mjs';
import { writeFileAtomic } from '../shared/config.mjs';
import { checkSkillVersions, skillsNeedingUpdate } from '../shared/skill-versions.mjs';

const STATE_FILE = 'update-state.json';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** `$LOREKIT_HOME/update-state.json`, default `~/.lorekit/update-state.json`. */
export function updateStatePath(env = process.env) {
  return path.join(homeRoot(env), STATE_FILE);
}

/**
 * Read the stored throttle state, or `{}`. TOTAL — a missing file, an
 * unreadable one, a corrupt body, or a body that parses but isn't the right
 * shape all yield `{}`, exactly like `telemetry-identity.mjs`'s `readIdentity`.
 */
export function readUpdateState(file = updateStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    if (typeof parsed.lastNotifiedVersion === 'string' && parsed.lastNotifiedVersion) {
      out.lastNotifiedVersion = parsed.lastNotifiedVersion;
    }
    if (typeof parsed.lastNotifiedAt === 'number' && Number.isFinite(parsed.lastNotifiedAt)) {
      out.lastNotifiedAt = parsed.lastNotifiedAt;
    }
    return out;
  } catch {
    return {};
  }
}

// Persist the throttle state, creating the home directory if needed. Returns
// true on success, false on any failure (unwritable home, full disk) — a
// write failure must not surface as an error, since a hook this fires from
// must never break the host on a filesystem hiccup.
function writeUpdateState(state, file = updateStatePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stable signature naming exactly which skills need an update and at which
 * shipped version, e.g. `"lorekit-memory@1.2.0,lorekit-setup@1.1.0"`. Sorted
 * by skill name so the signature is deterministic regardless of scan order.
 *
 * This — not a bare boolean — is what the throttle compares against: a NEW
 * release (a shipped version bump) or a previously-current skill drifting
 * produces a DIFFERENT signature, which re-qualifies for a nudge even inside
 * the 7-day cooldown on the old one. `""` means nothing needs an update.
 */
export function driftSignature(results) {
  const bySkill = new Map();
  for (const r of skillsNeedingUpdate(results)) {
    if (!r.shipped || bySkill.has(r.name)) continue;
    bySkill.set(r.name, r.shipped);
  }
  return [...bySkill.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, shipped]) => `${name}@${shipped}`)
    .join(',');
}

/**
 * Render the one-line nudge, or `null` when nothing needs an update. De-duped
 * by skill name (the same `name -> shipped` Map `driftSignature` builds) —
 * `skillsNeedingUpdate` returns one row per (skill, scope), and without the
 * dedupe a skill outdated in BOTH the project and global install would count
 * itself twice in the "(+N more)" tail. An `unknown` row (no readable
 * installed version — the drift signature counts it too, see
 * `driftSignature`) still gets named, just without a "vX →" on its left side,
 * so the nudge is never silently dropped for the one state that most needs a
 * "go look" — a legacy install with no parseable version at all.
 */
export function formatUpdateNudge(results) {
  const bySkill = new Map();
  for (const r of skillsNeedingUpdate(results)) {
    if (!r.shipped || bySkill.has(r.name)) continue;
    bySkill.set(r.name, r);
  }
  const needing = [...bySkill.values()];
  if (needing.length === 0) return null;
  const [first, ...rest] = needing;
  const extra = rest.length > 0 ? ` (+${rest.length} more)` : '';
  const headline = first.installed
    ? `${first.name} v${first.installed} → v${first.shipped}`
    : `${first.name} → v${first.shipped}`;
  return (
    `LoreKit skills are outdated (${headline}${extra}). ` +
    'Run `lorekit update` to refresh.'
  );
}

/**
 * The full resolve: should a SessionStart nudge fire right now, and if so,
 * record the throttle state and return the text? `null` means stay silent —
 * `notify: off`, nothing outdated, or the same signature is still inside its
 * 7-day cooldown.
 *
 * TOTAL and side-effect-light: nothing is read or written when `notify` is
 * `off`, and the state file is written ONLY on the turn that actually emits a
 * nudge — never merely because this ran. Any unexpected error (a throwing
 * filesystem call the individual helpers didn't already swallow) is caught
 * here too, so a caller never needs its own try/catch to stay safe.
 */
export function resolveUpdateNudge(root, { notify = 'auto', now = Date.now(), env = process.env } = {}) {
  if (notify === 'off') return null;
  try {
    const results = checkSkillVersions(root);
    const signature = driftSignature(results);
    if (!signature) return null;

    const file = updateStatePath(env);
    const state = readUpdateState(file);
    const sameSignature = state.lastNotifiedVersion === signature;
    const withinCooldown =
      typeof state.lastNotifiedAt === 'number' && now - state.lastNotifiedAt < COOLDOWN_MS;
    if (sameSignature && withinCooldown) return null;

    const text = formatUpdateNudge(results);
    if (!text) return null;

    writeUpdateState({ lastNotifiedVersion: signature, lastNotifiedAt: now }, file);
    return text;
  } catch {
    return null;
  }
}
