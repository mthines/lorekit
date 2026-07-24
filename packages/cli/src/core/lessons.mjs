// Shared hook logic: fetch and format lessons; build the nudge text.
// Framework-agnostic — adapters shape these strings into each tool's contract.
// Storage is reached through the resolved store (local | remote), never a
// backend directly, so the same read path serves every mode.
import { deriveScope } from '../scope.mjs';

const MAX_LESSONS = 15;

// Read lessons narrow-to-broad through the store and merge; more specific
// scope wins on key. Any per-scope failure is skipped (memory is best-effort).
export async function fetchLessons(store, cwd) {
  const scope = deriveScope(cwd);
  const byKey = new Map();
  for (const s of scope.readOrder) {
    const res = await store.list({ scope: s, limit: 25 });
    if (!res || !res.ok) continue;
    const entries = Array.isArray(res.entries) ? res.entries : [];
    for (const e of entries) {
      if (e && e.key && !byKey.has(e.key)) byKey.set(e.key, { ...e, scope: s });
    }
  }
  return { scope, lessons: [...byKey.values()].slice(0, MAX_LESSONS) };
}

// Render lessons as a compact markdown block, or null when there are none.
export function formatLessons(lessons, scope) {
  if (!lessons || lessons.length === 0) return null;
  const header =
    `LoreKit — ${lessons.length} shared lesson(s) for ${scope.repoScope || 'this workspace'}. ` +
    `Treat as considerations, not rules; trust the current code if they conflict.`;
  const body = lessons
    .map((l) => {
      const first = String(l.value || '').split('\n')[0].slice(0, 300);
      return `- (${l.scope}) ${l.key}: ${first}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

// The retrospective nudge emitted at end-of-turn (one-shot per session).
export function retrospectiveNudge(scope) {
  const writeScope = scope.repoScope || 'global';
  return (
    'LoreKit retrospective: if this session hit a stuck loop, a repeated ' +
    'command failure, a surprising gotcha, a near-miss, or a wrong assumption ' +
    'that cost time, record it now via the lorekit-memory skill ' +
    `(memory.write to ${writeScope}, phrased as an observation). ` +
    'If nothing was durable, do nothing.'
  );
}

// The nudge emitted when a tool failure is detected.
export function failureNudge(toolName, scope) {
  const writeScope = scope.repoScope || 'global';
  return (
    `LoreKit: the last ${toolName} call failed. If this is a recurring or ` +
    'non-obvious failure, consider recording the fix as a lesson via ' +
    `lorekit-memory (memory.write to ${writeScope}), so the next run avoids it.`
  );
}
