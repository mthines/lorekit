// Populate (or deliberately do not populate) a sandbox's scratch store.
//
// Seeding goes through the REAL resolution chain — `loadControl(root, { env })`
// → `createStore(control)` → `store.write(...)` — the same one the CLI, the MCP
// server and the hook use. Writing the markdown files directly would be faster
// and would be a mistake: the on-disk format is lossy in places
// (`packages/cli/src/store/format.mjs` stores `project::{name}` by basename),
// tier routing is a live decision in `TwoTierStore`, and a hand-written file
// that the real reader interprets differently would make every downstream
// number wrong in a way no test would catch.
//
// `loadControl` takes an `env` override, so this runs in-process against the
// sandbox env with no subprocess and no mutation of `process.env` — which also
// means two sandboxes can be seeded concurrently without racing.
import { loadControl } from "@lorekit/cli/src/shared/control.mjs";
import { createStore } from "@lorekit/cli/src/store/index.mjs";

import { canonicalLessonText } from "../harness/task.mjs";

/**
 * The curated gold lesson for arm B (canonical). Its TEXT lives in
 * `fixtures/canonical-lesson.md`, beside the task spec, so the lesson under
 * test can be read and revised as prose rather than as a string literal — and
 * so a test can assert it does not restate the task. A lesson containing the
 * answer to the exact prompt would measure copying, not recall.
 */
export const CANONICAL_LESSON = {
  key: "scope-format::double-colon-is-the-only-separator",
  tags: ["loop::eval-canonical"],
};

/**
 * The canonical lesson as a COMPLETE seedable entry — key, tags and body.
 *
 * `CANONICAL_LESSON` deliberately carries no `value` (the text lives in the
 * fixture), so spreading it straight into a seed call produces a body-less
 * entry. Every caller that wants to seed it must go through here.
 */
export async function canonicalLesson() {
  return { ...CANONICAL_LESSON, value: await canonicalLessonText() };
}

/** Resolve the real store for a sandbox. */
export function storeFor(sandbox) {
  const control = loadControl(sandbox.cwd, { env: sandbox.childEnv() });
  const store = createStore(control);
  if (!store) {
    throw new Error(
      `sandbox store is unavailable (control.mode=${control && control.mode})`,
    );
  }
  return { control, store };
}

/**
 * Arm A: assert the store is genuinely empty rather than assuming it.
 * A leftover entry would silently turn the control arm into a treatment arm.
 */
export async function empty(sandbox, { scopes = [] } = {}) {
  const { store } = storeFor(sandbox);
  const found = [];
  for (const scope of scopes) {
    const res = await store.list({ scope });
    for (const entry of (res && res.entries) || [])
      found.push(`${scope}::${entry.key}`);
  }
  if (found.length > 0) {
    throw new Error(`expected an empty store, found: ${found.join(", ")}`);
  }
  return { seeded: [] };
}

/**
 * Write one lesson through the real write path, failing loudly on rejection.
 *
 * The `value` guard is not defensive noise: the offline store coerces an
 * `undefined` body to `''` and reports success, so a caller that forgot the
 * text seeds an EMPTY lesson and every downstream assertion about retrieval
 * still passes — the arm silently stops testing what it claims to test. That
 * is the exact failure this file's header warns about, so it is refused here
 * rather than in each caller.
 */
export async function seedLesson(
  sandbox,
  { scope, key, value, tags = [] } = {},
) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `seedLesson: a non-empty lesson body is required (scope=${scope}, key=${key})`,
    );
  }
  const { store } = storeFor(sandbox);
  const res = await store.write({
    scope,
    key,
    value,
    tags,
    source_agent: "lorekit-evals",
  });
  if (!res || res.ok === false) {
    throw new Error(
      `seed failed for ${scope} / ${key}: ${(res && res.error) || "unknown error"}`,
    );
  }
  return { scope, key };
}

/**
 * Arm B (organic): seed the lesson the agent itself distilled in arm 0.
 * The text is passed in verbatim — the point of this source is that it is the
 * model's own words, warts included, not something the harness improved.
 */
export async function seedOrganic(
  sandbox,
  { scope, key, value, tags = [] } = {},
) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("seedOrganic: the arm-0 lesson text is required");
  }
  const seeded = await seedLesson(sandbox, {
    scope,
    key: key || "organic::arm0-distilled-lesson",
    value,
    tags: tags.length > 0 ? tags : ["loop::eval-organic"],
  });
  return { seeded: [seeded] };
}

/** Arm B (canonical): seed the curated gold lesson. */
export async function seedCanonical(sandbox, { scope, lesson = null } = {}) {
  const resolved = lesson || (await canonicalLesson());
  const seeded = await seedLesson(sandbox, { scope, ...resolved });
  return { seeded: [seeded] };
}

/** Seed an arbitrary corpus. PR5's padding sweep is built on this. */
export async function seedMany(sandbox, lessons = []) {
  const seeded = [];
  for (const lesson of lessons) seeded.push(await seedLesson(sandbox, lesson));
  return { seeded };
}

/** Every non-archived entry visible at `scopes`, read back through the store. */
export async function listAll(sandbox, scopes = []) {
  const { store } = storeFor(sandbox);
  const entries = [];
  for (const scope of scopes) {
    const res = await store.list({ scope });
    for (const entry of (res && res.entries) || [])
      entries.push({ ...entry, scope });
  }
  return entries;
}
