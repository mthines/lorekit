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

// Returns true the FIRST time called for a given (sessionId, tag), false after.
// Missing sessionId → always true (cannot throttle without a key).
export function firstTimeThisSession(sessionId, tag) {
  if (!sessionId) return true;
  const hash = crypto.createHash('sha256').update(`${sessionId}:${tag}`).digest('hex').slice(0, 16);
  const marker = path.join(stateDir(), `${hash}.seen`);
  try {
    // wx fails if the file already exists → not the first time.
    fs.writeFileSync(marker, '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}
