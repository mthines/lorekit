// Harvesting arm 0's own lesson, which is what makes arm B-organic reachable.
//
// These run against a real scratch sandbox and the real store resolution
// chain, with no model: the thing under test is whether the harness can read
// back what an agent wrote, and seeding through the same write path the agent
// uses is the only way that question is being asked honestly.
import assert from "node:assert/strict";
import { test } from "node:test";

import { withSandbox } from "../../src/sandbox/sandbox.mjs";
import {
  harvestOrganicLesson,
  seedLesson,
} from "../../src/sandbox/store-setup.mjs";

test("an empty arm-0 store harvests NOTHING, rather than something", async () => {
  await withSandbox({}, async (sandbox) => {
    // The arm ran and wrote nothing. That is a real outcome about the loop,
    // and the caller has to skip the arm — never substitute a lesson.
    assert.equal(await harvestOrganicLesson(sandbox), null);
  });
});

test("the lesson is harvested from the MALFORMED scope the agent actually used", async () => {
  await withSandbox({}, async (sandbox) => {
    // The exact shape observed in run 34109382154: every unseeded rep wrote to
    // `branch::owner/repo@branch`, using `@` where the second `::` belongs.
    // Harvesting only the canonical scope would return nothing from precisely
    // the runs worth harvesting — the ones that made the mistake.
    await seedLesson(sandbox, {
      scope: "branch::mthines/gw-tools@feat/x",
      key: "scope-format-lesson",
      value: "Use :: between repo and branch.",
    });
    const found = await harvestOrganicLesson(sandbox);
    assert.equal(found.value, "Use :: between repo and branch.");
    assert.equal(found.scope, "branch::mthines/gw-tools@feat/x");
    assert.equal(found.key, "scope-format-lesson");
    assert.equal(found.entries, 1);
  });
});

test("several writes harvest ONE lesson, and say how many there were", async () => {
  await withSandbox({}, async (sandbox) => {
    await seedLesson(sandbox, {
      scope: "global",
      key: "first",
      value: "first lesson",
    });
    await seedLesson(sandbox, {
      scope: "global",
      key: "second",
      value: "second lesson",
    });
    const found = await harvestOrganicLesson(sandbox);
    // Never a concatenation: seeding arm B with two turns' output would give it
    // more than any single pass of the loop produces, inflating the very arm
    // the experiment exists to measure.
    assert.ok(["first lesson", "second lesson"].includes(found.value));
    assert.doesNotMatch(found.value, /first lesson[\s\S]*second lesson/);
    // But the ambiguity is REPORTED, not hidden — a reader can see the pick.
    assert.equal(found.entries, 2);
  });
});

test("a body-less write is not harvestable material", async () => {
  await withSandbox({}, async (sandbox) => {
    // `seedLesson` refuses an empty body, so reaching this state means the
    // store itself holds a blank entry; harvesting it would seed arm B with
    // nothing and still report the arm as having run.
    await assert.rejects(
      () => seedLesson(sandbox, { scope: "global", key: "k", value: "   " }),
      /non-empty lesson body/,
    );
    assert.equal(await harvestOrganicLesson(sandbox), null);
  });
});
