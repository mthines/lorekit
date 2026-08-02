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
