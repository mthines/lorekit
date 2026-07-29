// `lorekit hook --adapter <claude|cursor|codex> [--event <name>]`
// The shared hook engine. Reads the framework's JSON on stdin, runs the shared
// logic, and prints the framework-shaped injection on stdout. Always exits 0 —
// a memory hook must never block or break the host agent.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { loadControl } from './control.mjs';
import { createStore } from './store/index.mjs';
import {
  fetchLessons,
  formatLessons,
  retrospectiveNudge,
  failureNudge,
  failureQuery,
  relevantLessons,
  formatRelevantLessons,
  writeConfirmation,
} from './core/lessons.mjs';
import { isFailure } from './core/failure.mjs';
import { firstTimeThisSession } from './core/state.mjs';
import { recordFixture } from './core/record.mjs';
import { claude } from './adapters/claude.mjs';
import { cursor } from './adapters/cursor.mjs';
import { codex } from './adapters/codex.mjs';

const ADAPTERS = { claude, cursor, codex };

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function hook(args) {
  // Guarded so any unexpected error still exits 0 (never break the host agent).
  try {
    return await run(args);
  } catch {
    return 0;
  }
}

async function run(args) {
  const adapter = ADAPTERS[args.adapter];
  if (!adapter) {
    // Unknown adapter: stay silent, don't disrupt the host.
    return 0;
  }

  const raw = await readStdin();
  let input = {};
  if (raw && raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }

  const parsed = adapter.parse(input);
  const event = args.event || parsed.event;

  // Harvest the real payload when recording is enabled (opt-in via env).
  recordFixture(args.adapter, event, raw);

  if (!event) return 0;

  const intent = adapter.intentFor(event);
  if (intent === 'noop') return 0;

  const root = resolveProjectRoot(
    args.dir || process.env.CLAUDE_PROJECT_DIR || parsed.cwd || undefined,
  );
  const scope = deriveScope(root);

  // Resolve the control model once. `off` disables every hook event — no read,
  // no nudges — so memory can be turned off entirely without touching config.
  const control = loadControl(root);
  if (control.mode === 'off') return 0;

  // `hooks.disabled` — skip the event if this event name is suppressed by config.
  if (control.hooksDisabled && control.hooksDisabled.has(event)) return 0;

  const emit = (text) => {
    if (text) process.stdout.write(adapter.emit(event, text));
  };

  if (intent === 'read') {
    if (!firstTimeThisSession(parsed.sessionId, 'read')) return 0;
    const store = createStore(control);
    // When there is no usable store, we still want to emit a custom instruction
    // if one is configured — so we don't bail out entirely on a missing store.
    const sessionInstruction = control.hooksInstructions && control.hooksInstructions.SessionStart
      ? control.hooksInstructions.SessionStart : null;
    if (!store) {
      // No store: emit a minimal header + instruction when present, then return.
      if (sessionInstruction) {
        emit(formatLessons(null, { repoScope: null }, { instruction: sessionInstruction }));
      }
      return 0;
    }
    const { scope: readScope, lessons } = await fetchLessons(store, root);
    emit(formatLessons(lessons, readScope, { instruction: sessionInstruction }));
    return 0;
  }

  if (intent === 'confirm') {
    // Fire only when a lorekit memory write actually succeeded — the adapter's
    // isLoreWrite() inspects the tool name and the response shape. Any error
    // is swallowed (exit 0 — never block the host).
    try {
      if (adapter.isLoreWrite && adapter.isLoreWrite(parsed.toolName, parsed.toolResponse)) {
        const key = (parsed.toolResponse && parsed.toolResponse.input && parsed.toolResponse.input.key)
          || (parsed.toolResponse && parsed.toolResponse.key)
          || null;
        emit(writeConfirmation(scope, key));
      }
    } catch {
      // best-effort — never break the host
    }
    return 0;
  }

  if (intent === 'failure') {
    const known = adapter.guaranteedFailure ? adapter.guaranteedFailure(event) : false;
    if (!known && !isFailure(parsed.toolName, parsed.toolResponse)) return 0;
    if (!firstTimeThisSession(parsed.sessionId, 'failure')) return 0;
    // Best-effort: surface any existing lessons that look relevant to THIS
    // failure ("you've hit this before"), then the write-nudge. A missing /
    // unusable store, or no match, silently falls back to the nudge alone.
    let relevant = null;
    try {
      const store = createStore(control);
      if (store) {
        const { lessons } = await fetchLessons(store, root);
        const terms = failureQuery(parsed.toolName, parsed.toolResponse);
        relevant = formatRelevantLessons(relevantLessons(lessons, terms));
      }
    } catch {
      relevant = null; // never let a lesson lookup break the failure nudge
    }
    const nudge = failureNudge(parsed.toolName, scope, control);
    emit(relevant ? `${relevant}\n\n${nudge}` : nudge);
    return 0;
  }

  if (intent === 'retrospective') {
    if (!firstTimeThisSession(parsed.sessionId, 'retro')) return 0;
    emit(retrospectiveNudge(scope, control));
    return 0;
  }

  return 0;
}
