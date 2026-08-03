// Friction detection for the Stop (retrospective) hook.
//
// The retrospective nudge has no side effect of its own — it exists only to
// prompt an end-of-turn reflection. Firing it on *every* session is noise: a
// clean "regenerate four icons" turn had nothing worth remembering. So when
// `hooks.stop` is `friction` (the default) we read the session transcript and
// only surface the nudge when the session actually hit friction.
//
// Signals are deliberately conservative (a false positive nudges needlessly):
//   - `failure`    — a tool call reported an error this session (is_error).
//   - `stuck-loop` — the same tool+input ran >= STUCK_LOOP_THRESHOLD times
//                    (a retry loop / repeated dead end).
//
// The pure `detectFriction` works on the raw transcript text so it is unit
// testable with fixture strings; `readSessionFriction` is the thin IO wrapper.
// Both are best-effort: anything unreadable degrades to `friction: null`
// ("unknown"), never a throw — a memory hook must never break the host.
import fs from 'node:fs';

export const STUCK_LOOP_THRESHOLD = 3;

// Reason codes, surfaced in the nudge so the reflection is grounded ("this
// session hit a failed tool call") rather than a generic prompt.
export const FRICTION_FAILURE = 'failure';
export const FRICTION_STUCK_LOOP = 'stuck-loop';

// Pure: scan a Claude Code JSONL transcript for friction signals. (Only Claude
// Code surfaces a transcript path to the hook; the Cursor/Codex adapters don't,
// so friction there is always `null` — see readSessionFriction / shouldRetrospect.)
// Returns { friction: boolean, reasons: string[] }. Never throws.
export function detectFriction(transcriptText, { stuckLoopThreshold = STUCK_LOOP_THRESHOLD } = {}) {
  const reasons = new Set();
  if (typeof transcriptText !== 'string' || transcriptText.length === 0) {
    return { friction: false, reasons: [] };
  }

  const callCounts = new Map(); // "name input" -> count
  for (const line of transcriptText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON / partial lines
    }
    const content = entry && entry.message && Array.isArray(entry.message.content)
      ? entry.message.content
      : null;
    if (!content) continue;

    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_result' && item.is_error === true) {
        reasons.add(FRICTION_FAILURE);
      } else if (item.type === 'tool_use' && typeof item.name === 'string') {
        // Serialize the input so identical retries collide; JSON.stringify is
        // enough for the loop signal (key order is stable within one session).
        let inputKey = '';
        try {
          inputKey = JSON.stringify(item.input ?? null);
        } catch {
          inputKey = '';
        }
        const key = `${item.name} ${inputKey}`;
        const next = (callCounts.get(key) || 0) + 1;
        callCounts.set(key, next);
        if (next >= stuckLoopThreshold) reasons.add(FRICTION_STUCK_LOOP);
      }
    }
  }

  return { friction: reasons.size > 0, reasons: [...reasons] };
}

// IO wrapper: read the transcript at `transcriptPath` and detect friction.
// Returns { friction: null, reasons: [] } when the path is absent or unreadable
// — "unknown", which the caller treats conservatively (does not swallow the
// nudge on platforms/turns where we cannot measure).
export function readSessionFriction(transcriptPath, opts = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { friction: null, reasons: [] };
  }
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { friction: null, reasons: [] };
  }
  return detectFriction(text, opts);
}

// Pure gating decision for the retrospective hook, given the resolved
// `hooks.stop` mode and the detected friction (true | false | null=unknown):
//   - off      → never
//   - always   → always
//   - friction → only on positively-detected friction; `null` (undetectable,
//                e.g. no transcript on Cursor/Codex) falls back to firing so no
//                lesson is silently lost where we cannot measure.
export function shouldRetrospect(mode, friction) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // friction mode
  return friction !== false;
}
