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
 * Read back what arm 0 wrote, so arm B (organic) can be seeded with it.
 *
 * This is the SAME move arm C already makes with arm 0's transcript: arm 0
 * exists to produce the material the later arms consume, and requiring an
 * operator to ferry that material out of an artifact by hand is why the
 * organic arm had never once run. The transcript is carried automatically;
 * the lesson was not, and the asymmetry was not a decision.
 *
 * Enumerated with `listScopes()` rather than read from the target scope,
 * for the reason `gradeSandbox` gives: the agent may have written somewhere
 * nobody predicted — and in practice it does, since the very mistake under
 * test is writing to a MALFORMED scope. Reading only the canonical scope
 * would harvest nothing from exactly the runs worth harvesting.
 *
 * Returns `null` when arm 0 wrote nothing usable. That is a real outcome, not
 * an error: it means the loop this experiment is about did not produce a
 * lesson, and the caller must skip the arm rather than substitute one.
 *
 * @returns {Promise<null | {value: string, key: string, scope: string, entries: number}>}
 */
export async function harvestOrganicLesson(sandbox) {
  const { store } = storeFor(sandbox);
  const inventory = (await store.listScopes())
    .slice()
    .sort((a, b) => a.scope.localeCompare(b.scope));
  const found = [];
  for (const row of Array.isArray(inventory) ? inventory : []) {
    const res = await store.list({ scope: row.scope });
    for (const entry of (res && res.entries) || []) {
      if (typeof entry.value === "string" && entry.value.trim() !== "") {
        found.push({
          value: entry.value.trim(),
          key: entry.key,
          scope: row.scope,
        });
      }
    }
  }
  if (found.length === 0) return null;
  // ONE lesson, never a concatenation of several — the same rule arm C's
  // digest follows. Merging what the agent wrote across two writes would seed
  // arm B with more than any single turn of the loop ever produces, which
  // inflates the arm the whole experiment is trying to measure honestly.
  // `list()` is newest-first, and the inventory is sorted above because
  // `listScopes()` documents itself as unsorted (it returns `Map` insertion
  // order from a filesystem walk), so this is the most recent write of the
  // alphabetically-first scope holding one — deterministic across runs.
  return { ...found[0], entries: found.length };
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
