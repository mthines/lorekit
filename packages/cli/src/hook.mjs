// `lorekit hook --adapter <claude|cursor|codex> [--event <name>]`
// The shared hook engine. Reads the framework's JSON on stdin, runs the shared
// logic, and prints the framework-shaped injection on stdout. Always exits 0 —
// a memory hook must never block or break the host agent.
import process from 'node:process';
import { resolveProjectRoot, resolveProjectConnection } from './config.mjs';
import { splitEndpoint } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { fetchLessons, formatLessons, retrospectiveNudge, failureNudge } from './core/lessons.mjs';
import { isFailure } from './core/failure.mjs';
import { firstTimeThisSession } from './core/state.mjs';
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
  if (!event) return 0;

  const intent = adapter.intentFor(event);
  if (intent === 'noop') return 0;

  const root = resolveProjectRoot(
    args.dir || process.env.CLAUDE_PROJECT_DIR || parsed.cwd || undefined,
  );
  const scope = deriveScope(root);
  const emit = (text) => {
    if (text) process.stdout.write(adapter.emit(event, text));
  };

  if (intent === 'read') {
    if (!firstTimeThisSession(parsed.sessionId, 'read')) return 0;
    const { endpoint, token } = resolveProjectConnection(root, splitEndpoint);
    if (!endpoint || !token) return 0; // memory not configured — stay silent
    const { scope: readScope, lessons } = await fetchLessons(endpoint, token, root);
    emit(formatLessons(lessons, readScope));
    return 0;
  }

  if (intent === 'failure') {
    const known = adapter.guaranteedFailure ? adapter.guaranteedFailure(event) : false;
    if (!known && !isFailure(parsed.toolName, parsed.toolResponse)) return 0;
    if (!firstTimeThisSession(parsed.sessionId, 'failure')) return 0;
    emit(failureNudge(parsed.toolName, scope));
    return 0;
  }

  if (intent === 'retrospective') {
    if (!firstTimeThisSession(parsed.sessionId, 'retro')) return 0;
    emit(retrospectiveNudge(scope));
    return 0;
  }

  return 0;
}
