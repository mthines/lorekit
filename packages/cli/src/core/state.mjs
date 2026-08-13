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
// STORED AS LINES, APPENDED on the hot path. An append is atomic enough for
// this: two hooks racing can interleave whole lines but cannot corrupt one, and
// a duplicate line is harmless because the reader is a Set. A read-modify-write
// on every write would be the version that loses entries under a race — which
// is why the common write stays a bare append. Left there the file would grow
// without bound in a long session, so it is instead bounded by an occasional
// atomic-rename compaction (see COMPACT_AT_BYTES below), never a per-write
// rewrite.

// Cap on how many ids are READ back per session — the newest N. Reading only
// the newest N is enough for what this guards: the value of an id decays, and
// re-showing a lesson from 600 injections ago is not the repetition the
// shown-set exists to prevent.
const MAX_SHOWN_IDS = 500;

// Bound the file ON DISK, not just the read. The append-only writer keeps the
// hot path race-safe, but on its own a long session would grow the file without
// limit. Once the file passes this size the writer rewrites it down to the
// newest MAX_SHOWN_IDS ids via a temp-file + atomic rename (see
// `compactIfLarge`). The threshold sits well above what `shownLessons` ever
// reads, so compaction is rare — amortized O(1) per append — and never drops an
// id still inside the read window. It is session-scoped scratch in a
// temp/plugin-data directory the host clears with the rest of the session's
// hook state; compaction just keeps it bounded within one long-lived session.
const COMPACT_AT_BYTES = 256 * 1024;

function shownPath(sessionId) {
  return `${markerPath(sessionId, 'shown')}.ids`;
}

// Rewrite the append-only file down to its newest MAX_SHOWN_IDS ids once it has
// grown past COMPACT_AT_BYTES, via a temp-file + atomic rename. rename(2) is
// atomic on POSIX and the temp file lives in the same directory (so the same
// filesystem), so a concurrent reader always sees a complete old-or-new file,
// never a torn one. A racing append lost to the rename is the same "at worst a
// repeat" trade the bare append already makes, and it can only happen on the
// rare compaction — not the hot path. Best-effort: any failure leaves the file
// as-is and never breaks the host.
function compactIfLarge(file) {
  try {
    if (fs.statSync(file).size <= COMPACT_AT_BYTES) return;
    const kept = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_SHOWN_IDS);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(tmp, file);
  } catch {
    // Compaction is best-effort; a failure just leaves the file large.
  }
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
    // No mkdir here: `shownPath` → `markerPath` → `stateDir`, which creates the
    // directory as part of resolving the path.
    const file = shownPath(sessionId);
    fs.appendFileSync(file, `${clean.join('\n')}\n`);
    // The append above is the race-safe hot path; this bounds the file on disk,
    // rewriting down to the newest ids only once it has grown large.
    compactIfLarge(file);
  } catch {
    // Never break the host over bookkeeping.
  }
}
