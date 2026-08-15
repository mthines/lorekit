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
  promptQuery,
  promptLessonsFromStore,
  formatPromptLessons,
  lessonId,
  relevantLessonsFromStore,
  formatRelevantLessons,
  writeConfirmation,
} from './core/lessons.mjs';
import { isFailure } from './core/failure.mjs';
import { readSessionFriction, shouldRetrospect, FRICTION_FAILURE } from './core/friction.mjs';
import {
  firstTimeThisSession,
  sessionMarkerExists,
  shownLessons,
  recordShownLessons,
} from './core/state.mjs';
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
    const { scope: readScope, lessons, scopeCounts, applicable } = await fetchLessons(store, root, {
      loopCap: control.hooksSessionStartLoopCap,
      branchHint: control.hooksSessionStartBranchHint !== 'off',
    });
    emit(formatLessons(lessons, readScope, {
      instruction: sessionInstruction,
      mode: control.hooksSessionStart,
      maxChars: control.hooksSessionStartMaxChars,
      scopeCounts,
      applicable,
      // Record what this injection RENDERED, so the per-prompt hook treats it as
      // already seen. It must be the rendered subset, not the fetched set: the
      // budget and the hard ceiling routinely drop lessons, and marking those
      // shown would let the delta gate suppress — for the whole session —
      // exactly the lessons the reader never saw. Bookkeeping only:
      // `recordShownLessons` never throws, and a failure costs at most one
      // repeated lesson later in the session.
      onShown: (rendered) => recordShownLessons(parsed.sessionId, rendered.map(lessonId)),
    }));
    return 0;
  }

  if (intent === 'relevant-read') {
    // The per-turn relevance pull. Fires on EVERY prompt, so every branch below
    // is a reason to stay silent — the hook's default answer is nothing.
    //
    // Config gate, and the ONLY off switch some users have. Via `install` the
    // event is wired by hook mode `all` alone, so reaching here means the user
    // opted into the full lifecycle and `hooks.userPrompt` lets them keep it
    // while switching off just this one. Via the Claude marketplace plugin
    // there is no mode at all — `plugins/lorekit-claude/hooks/hooks.json` wires
    // the event unconditionally — so for a plugin install this setting is the
    // whole opt-out.
    if ((control.hooksUserPrompt || 'on') === 'off') return 0;

    // Length gate. "yes" / "continue" / "do it" carry nothing worth querying,
    // and a store lookup per acknowledgement is pure overhead on the user's
    // critical path.
    const terms = promptQuery(parsed.prompt);
    if (terms.length === 0) return 0;

    try {
      const store = createStore(control);
      if (!store) return 0;
      const lessons = await promptLessonsFromStore(store, scope, terms, {
        // Delta only. Includes the SessionStart set, because "already shown"
        // has to mean shown by anything — a hook that only remembered its own
        // output would resurface the session's opening injection one lesson at
        // a time.
        alreadyShown: shownLessons(parsed.sessionId),
      });
      // Relevance gate: nothing matched, or everything that matched was already
      // on screen. Either way there is no news, and an "in case it helps" block
      // attached to an unrelated prompt is how a reader learns to skip the
      // block entirely — which would cost the SessionStart injection its
      // credibility too.
      if (lessons.length === 0) return 0;
      recordShownLessons(parsed.sessionId, lessons.map(lessonId));
      emit(formatPromptLessons(lessons, {
        instruction: (control.hooksInstructions && control.hooksInstructions.UserPromptSubmit) || null,
      }));
    } catch {
      // Best-effort, like every other branch: the user's turn proceeds either
      // way, and a store hiccup must never cost them their prompt.
    }
    return 0;
  }

  if (intent === 'confirm') {
    // Fire only when a lorekit memory write actually succeeded — the adapter's
    // isLoreWrite() inspects the tool name and the response shape. Any error
    // is swallowed (exit 0 — never block the host).
    try {
      if (adapter.isLoreWrite && adapter.isLoreWrite(parsed.toolName, parsed.toolResponse)) {
        // The lesson key comes from the tool INPUT (what the agent sent), not
        // the response (which only carries id + created_at). toolInput is
        // populated by the adapter's parse() from the raw hook stdin.
        const key = (parsed.toolInput && typeof parsed.toolInput.key === 'string')
          ? parsed.toolInput.key
          : null;
        // The scope the write actually targeted (tool input) — the confirmation
        // link must point there, not at the cwd's repo scope, or a global/project
        // write would deep-link to a lesson ref that doesn't exist.
        const writtenScope = (parsed.toolInput && typeof parsed.toolInput.scope === 'string' && parsed.toolInput.scope)
          ? parsed.toolInput.scope
          : null;
        emit(writeConfirmation(scope, key, writtenScope));
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
        // QUERY the store across the scope hierarchy for lessons matching this
        // failure — not a post-filter of the SessionStart-injected set, which
        // could only ever resurface an already-shown lesson. Matching is the
        // store's job (server FTS with stemming for remote, full-scope substring
        // for local), so a paraphrased prior lesson can still surface.
        const terms = failureQuery(parsed.toolName, parsed.toolResponse);
        relevant = formatRelevantLessons(await relevantLessonsFromStore(store, scope, terms));
      }
    } catch {
      relevant = null; // never let a lesson lookup break the failure nudge
    }
    const nudge = failureNudge(parsed.toolName, scope, control);
    emit(relevant ? `${relevant}\n\n${nudge}` : nudge);
    return 0;
  }

  if (intent === 'retrospective') {
    // `hooks.stop` gates the retrospective: `friction` (default) reads the
    // session transcript and only nudges when it hit real friction; `always`
    // keeps the once-per-session nudge; `off` is silent. The friction read is
    // side-effect-free and happens BEFORE the once-per-session throttle is
    // consumed, so a clean early turn stays silent without burning the marker —
    // a later turn that does hit friction can still fire (once).
    const stopMode = control.hooksStop || 'friction';
    // Once the retro has fired, short-circuit BEFORE the (growing) transcript
    // read — the 'retro' marker is only ever SET on emit below, so a clean
    // earlier turn never reaches that line to consume it, and every later Stop
    // this session skips the re-parse cheaply (read-only peek, never consumed).
    if (sessionMarkerExists(parsed.sessionId, 'retro')) return 0;
    let reasons = [];
    let friction = null;
    if (stopMode === 'friction') {
      ({ friction, reasons } = readSessionFriction(parsed.transcriptPath));
      // The transcript is written ASYNCHRONOUSLY and may lag the current turn
      // (Claude Code hooks reference, `transcript_path`), so a Stop fired right
      // after a failing tool call can read a positively-clean `false`. The
      // PostToolUseFailure hook already left a session-keyed marker when it
      // fired, which is a transcript-independent witness of the exact same
      // predicate `detectFriction` calls FRICTION_FAILURE (any errored tool
      // result anywhere this session). Peek at it (read-only — never consume
      // the marker) and upgrade. This covers the `failure` signal ONLY;
      // `stuck-loop` remains transcript-only and is still exposed to the lag.
      if (friction === false && sessionMarkerExists(parsed.sessionId, 'failure')) {
        friction = true;
        reasons = [FRICTION_FAILURE];
      }
    }
    if (!shouldRetrospect(stopMode, friction)) return 0;
    if (!firstTimeThisSession(parsed.sessionId, 'retro')) return 0;
    emit(retrospectiveNudge(scope, control, { reasons }));
    return 0;
  }

  return 0;
}
