// One-shot throttle so a hook fires an injection at most once per session/tag.
// Prevents nudge spam and, on Stop hooks, avoids re-injection loops.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function stateDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'lorekit-hooks');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function markerPath(sessionId, tag) {
  const hash = crypto.createHash('sha256').update(`${sessionId}:${tag}`).digest('hex').slice(0, 16);
  return path.join(stateDir(), `${hash}.seen`);
}

// Returns true the FIRST time called for a given (sessionId, tag), false after.
// Missing sessionId → always true (cannot throttle without a key).
export function firstTimeThisSession(sessionId, tag) {
  if (!sessionId) return true;
  try {
    // wx fails if the file already exists → not the first time.
    fs.writeFileSync(markerPath(sessionId, tag), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Read-only peek: has a (sessionId, tag) marker already been written this
// session? Unlike `firstTimeThisSession` this NEVER creates the marker, so a
// caller can ask "did the failure hook already fire?" without consuming a
// throttle it does not own. Missing sessionId (or any IO error) → false.
export function sessionMarkerExists(sessionId, tag) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(markerPath(sessionId, tag));
  } catch {
    return false;
  }
}

// ── the per-session shown-set ────────────────────────────────────────────────
//
// The one-shot markers above answer "has this hook fired yet". The per-prompt
// relevance hook needs a finer question: "has the reader already been shown
// THIS lesson this session". Without it the hook re-injects its own best match
// on every turn of a conversation that stays on one topic — which is the exact
// shape that turns an injection into wallpaper the reader learns to skip.
//
// Deliberately the same directory and the same session key as the markers, so a
// session's hook state is one thing that appears and disappears together.
//
// STORED AS LINES, APPENDED, NEVER REWRITTEN. An append is atomic enough for
// this: two hooks racing can interleave whole lines but cannot corrupt one, and
// a duplicate line is harmless because the reader is a Set. A read-modify-write
// would be the version that loses entries under a race.

// Cap on how many ids are READ back per session — it bounds the shown-set, not
// the file. The writer stays a bare append (that is what makes it race-safe),
// so a long session with a large store still grows the file on disk; it is
// session-scoped scratch in a temp/plugin-data directory, and the host clears
// it with the rest of the session's hook state.
//
// Reading only the newest N is enough for what this guards: the value of an id
// decays, and re-showing a lesson from 600 injections ago is not the repetition
// the shown-set exists to prevent.
const MAX_SHOWN_IDS = 500;

function shownPath(sessionId) {
  return `${markerPath(sessionId, 'shown')}.ids`;
}

/**
 * The set of `scope::key` ids already injected this session.
 *
 * Missing session id, missing file, or an unreadable one all yield an EMPTY
 * set, which fails toward showing a lesson again rather than toward silence. A
 * repeated lesson is a small annoyance; a lesson silently withheld because a
 * state file could not be read is the failure nobody would ever diagnose.
 */
export function shownLessons(sessionId) {
  if (!sessionId) return new Set();
  try {
    const lines = fs.readFileSync(shownPath(sessionId), 'utf8').split('\n');
    const kept = lines.filter(Boolean).slice(-MAX_SHOWN_IDS);
    return new Set(kept);
  } catch {
    return new Set();
  }
}

/**
 * Record ids as shown. Best-effort: a failed write means at worst a repeat.
 *
 * Called by BOTH injection paths — SessionStart records what it injected, and
 * the per-prompt hook records what it added — because "already shown" has to
 * mean shown by anything, not shown by this hook. A per-prompt hook that only
 * remembered its own output would re-surface the SessionStart set one lesson at
 * a time.
 */
export function recordShownLessons(sessionId, ids) {
  if (!sessionId || !Array.isArray(ids) || ids.length === 0) return;
  const clean = ids.filter((id) => typeof id === 'string' && id && !id.includes('\n'));
  if (clean.length === 0) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(shownPath(sessionId), `${clean.join('\n')}\n`);
  } catch {
    // Never break the host over bookkeeping.
  }
}
