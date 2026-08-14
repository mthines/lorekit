import assert from "node:assert/strict";
import { test } from "node:test";

import {
  redactToMetadata,
  privacyPreflight,
  parseMineArgs,
  main,
  METADATA_FIELDS,
  OUTCOME_TAGS,
} from "../bin/mine-ground-truth.mjs";

test("AC-5: redactToMetadata drops the lesson body and keeps only metadata", () => {
  const row = {
    scope: "repo::mthines/lorekit",
    key: "rls::service-role-user-filter",
    value: "api_key auth uses the service-role client — every query MUST .eq(user_id, userId).",
    tags: ["security", "rls", "loop::review-outcomes"],
    origin_pr: null,
    seenCount: 4,
    created_at: "2026-01-01T00:00:00Z",
  };
  const out = redactToMetadata(row);
  assert.deepEqual(Object.keys(out).sort(), [...METADATA_FIELDS].sort());
  assert.equal("value" in out, false);
  assert.equal("body" in out, false);
  assert.equal("created_at" in out, false);
  assert.equal(out.seenCount, 4);
  assert.equal(out.scope, row.scope);
});

test("AC-5: redactToMetadata reads seen_count OR seenCount and floors it", () => {
  assert.equal(redactToMetadata({ seen_count: 7 }).seenCount, 7);
  assert.equal(redactToMetadata({ seenCount: 3.9 }).seenCount, 3);
  assert.equal(redactToMetadata({}).seenCount, null);
});

test("AC-5: privacyPreflight passes clean metadata through unchanged", () => {
  const entries = [
    { scope: "repo::x/y", key: "a::b", tags: ["loop::review-outcomes"], origin_pr: 1, seenCount: 2 },
  ];
  assert.deepEqual(privacyPreflight(entries), entries);
});

test("AC-5: privacyPreflight throws when an entry still carries a body", () => {
  assert.throws(
    () => privacyPreflight([{ scope: "s", key: "k", tags: [], value: "leaked body" }]),
    /must never be emitted/,
  );
  assert.throws(
    () => privacyPreflight([{ scope: "s", key: "k", tags: [], body: "leaked body" }]),
    /must never be emitted/,
  );
});

test("AC-5: privacyPreflight throws on a non-metadata field", () => {
  assert.throws(
    () => privacyPreflight([{ scope: "s", key: "k", tags: [], origin_pr: 1, seenCount: 0, extra: "x" }]),
    /non-metadata field/,
  );
});

test("AC-5: privacyPreflight throws on a secret-shaped string", () => {
  // A key that somehow embeds a token-shaped string is refused.
  assert.throws(
    () =>
      privacyPreflight([
        { scope: "s", key: "ghp_ABCDEFGHIJKLMNOPQRSTUV", tags: [], origin_pr: null, seenCount: 0 },
      ]),
    /secret\/PII-shaped/,
  );
});

test("AC-6: parseMineArgs requires --confirm and rejects unknown flags", () => {
  assert.equal(parseMineArgs([]).confirm, false);
  assert.equal(parseMineArgs(["--confirm"]).confirm, true);
  assert.equal(parseMineArgs(["--scope", "repo::a/b"]).scope, "repo::a/b");
  assert.throws(() => parseMineArgs(["--nope"]), /unknown option/);
});

test("AC-6: main([]) refuses without --confirm, exits non-zero, and makes NO network call", async () => {
  const out = [];
  const errs = [];
  // A deps.resolveStores that would THROW if the store were ever reached — the
  // refusal must return before any store resolution, so this is never called.
  const resolveStores = () => {
    throw new Error("resolveStores must not be reached on the refusal path");
  };
  const code = await main([], {
    log: (m) => out.push(String(m)),
    err: (m) => errs.push(String(m)),
    deps: { resolveStores },
  });
  assert.equal(code, 2);
  const joined = errs.join("\n");
  assert.match(joined, /--confirm/);
  // The placeholder → real explanation is printed so the operator learns what
  // running the script actually buys.
  assert.match(joined, /Placeholder → real/);
  assert.match(joined, /ground-truth\.real\.json/);
  assert.match(joined, /MUST NOT/);
});

test("AC-6: --confirm with no usable remote connection refuses to write and makes no query", async () => {
  const errs = [];
  // A remote that is explicitly unusable — list() would throw if reached.
  const resolveStores = () => ({
    remote: {
      usable: () => false,
      list: () => {
        throw new Error("remote.list must not be called when the connection is unusable");
      },
    },
    connection: { endpoint: null },
  });
  const code = await main(["--confirm"], {
    log: () => {},
    err: (m) => errs.push(String(m)),
    deps: { resolveStores },
  });
  assert.equal(code, 3);
  assert.match(errs.join("\n"), /No usable remote connection/);
  assert.match(errs.join("\n"), /Nothing was written/);
});

test("the outcome tags are exactly the two the spec names", () => {
  assert.deepEqual(
    new Set(OUTCOME_TAGS),
    new Set(["loop::review-outcomes", "loop::reviewer-comment-relevance"]),
  );
});
