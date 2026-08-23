// The harness must measure with the SAME code production uses. Re-implementing
// the scope validator or the friction detector would let the eval and the
// product drift apart silently, and a harness that disagrees with the system it
// grades is worse than no harness.
//
// These imports are the two load-bearing cross-package dependencies (resolved
// as OQ-1 and OQ-5 of the plan). They are exercised here in PR1 — ahead of the
// PR3 grader and the PR4 metrics that consume them — so the resolution
// mechanism is proven by an executable check rather than by a plan paragraph,
// and so an upstream move breaks one obvious test.
import assert from "node:assert/strict";
import { test } from "node:test";

test("validateScope is imported from the canonical scope.ts (OQ-1, seam for AC-3.2)", async () => {
  // `@lorekit/core` publishes no build output and has no `exports` map, so the
  // TypeScript source is imported directly: Node >= 22.18 strips the types on
  // load (this package declares that engine). No vendored copy, no build step.
  const { validateScope, ScopeValidationError } = await import(
    "@lorekit/core/src/scope/scope.ts"
  );

  assert.equal(typeof validateScope, "function");
  assert.equal(
    validateScope("branch::mthines/gw-tools::feat/x"),
    "branch::mthines/gw-tools::feat/x",
  );
  assert.equal(
    validateScope("BRANCH::mthines/GW-Tools::feat/X"),
    "branch::mthines/gw-tools::feat/x",
  );

  // The gotcha the golden task is built around: a single colon must be invalid.
  assert.throws(
    () => validateScope("branch:mthines/gw-tools"),
    ScopeValidationError,
  );
  assert.throws(
    () => validateScope("repo:mthines/gw-tools"),
    ScopeValidationError,
  );
});

test("detectFriction is imported from the CLI, never re-implemented (seam for AC-4.1)", async () => {
  const { detectFriction, STUCK_LOOP_THRESHOLD, FRICTION_FAILURE } =
    await import("@lorekit/cli/src/core/friction.mjs");

  assert.equal(typeof detectFriction, "function");
  assert.equal(STUCK_LOOP_THRESHOLD, 3);

  // A stream-json transcript line has the same `message.content[]` shape the
  // detector expects from a Claude Code session transcript — which is why the
  // agent module captures `stream-json` (OQ-4).
  const transcript = [
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    }),
  ].join("\n");
  const { friction, reasons } = detectFriction(transcript);
  assert.equal(friction, true);
  assert.deepEqual(reasons, [FRICTION_FAILURE]);
});

test("the canonical SessionStart hook wiring is reusable (OQ-3, seam for AC-2.2)", async () => {
  // OQ-3 asked whether to shell out to `lorekit install --hooks read-only` or
  // hand-write the settings block. Neither: `upsertClaudeHooks` is an exported
  // pure-ish function that writes the canonical block into any root, so PR2 can
  // call it directly and stay in lockstep with CLAUDE_HOOK_EVENTS by
  // construction instead of by a drift test.
  const { CLAUDE_HOOK_EVENTS, upsertClaudeHooks, settingsPath } = await import(
    "@lorekit/cli/src/shared/config.mjs"
  );

  assert.equal(typeof upsertClaudeHooks, "function");
  // Derive the invariant instead of pinning the frozen roster: a hardcoded
  // deep-equal restales every time a lifecycle event lands (as UserPromptSubmit
  // did), the same reason the eight CLI tests derive from CLAUDE_HOOK_EVENTS. A
  // successful `includes` already implies a non-empty array holding a non-empty
  // string, so this single assert is the load-bearing one: the constant is
  // importable and carries the SessionStart wiring this seam is named for.
  assert.ok(
    CLAUDE_HOOK_EVENTS.includes("SessionStart"),
    "CLAUDE_HOOK_EVENTS is importable and carries the SessionStart wiring",
  );
  assert.match(
    settingsPath("/tmp/root"),
    /\/tmp\/root\/\.claude\/settings\.json$/,
  );
});
