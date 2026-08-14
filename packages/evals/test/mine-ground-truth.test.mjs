import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  redactToMetadata,
  privacyPreflight,
  parseMineArgs,
  main,
  METADATA_FIELDS,
  OUTCOME_TAGS,
  PAGE_LIMIT,
  SERVICE_ROLE_ENV,
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

// A remote whose `list` serves `rows` in pages of `PAGE_LIMIT`, reporting
// `hasMore`/`nextCursor` exactly as the hosted store does.
function pagingRemote(rowsByTag, { repeatCursor = false } = {}) {
  const calls = [];
  return {
    calls,
    remote: {
      usable: () => true,
      list: ({ tags, cursor }) => {
        const tag = tags[0];
        const rows = rowsByTag[tag] ?? [];
        const offset = cursor ? Number(cursor) : 0;
        const page = rows.slice(offset, offset + PAGE_LIMIT);
        const next = offset + page.length;
        calls.push({ tag, cursor: cursor ?? null });
        return {
          ok: true,
          entries: page,
          hasMore: next < rows.length,
          nextCursor:
            next < rows.length ? String(repeatCursor ? offset : next) : null,
        };
      },
    },
    connection: { endpoint: "https://example.test" },
  };
}

const rowsFor = (tag, n, prefix) =>
  Array.from({ length: n }, (_, i) => ({
    scope: "repo::mthines/lorekit",
    key: `${prefix}::${i}`,
    tags: [tag],
    origin_pr: null,
    seenCount: i,
    value: "a lesson body that must never be emitted",
  }));

test("AC-5: the mine walks EVERY page — a >PAGE_LIMIT tag is not silently truncated", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mine-gt-"));
  const out = path.join(dir, "ground-truth.real.json");
  const { remote, connection, calls } = pagingRemote({
    [OUTCOME_TAGS[0]]: rowsFor(OUTCOME_TAGS[0], PAGE_LIMIT + 42, "a"),
    [OUTCOME_TAGS[1]]: rowsFor(OUTCOME_TAGS[1], 3, "b"),
  });

  const code = await main(["--confirm", "--out", out], {
    log: () => {},
    err: () => {},
    deps: { resolveStores: () => ({ remote, connection }) },
  });

  assert.equal(code, 0);
  const snapshot = JSON.parse(await fsp.readFile(out, "utf8"));
  assert.equal(snapshot.entries.length, PAGE_LIMIT + 42 + 3);
  // Two pages for the first tag, one for the second — the cursor was followed.
  assert.equal(calls.filter((c) => c.tag === OUTCOME_TAGS[0]).length, 2);
  assert.equal(calls.filter((c) => c.tag === OUTCOME_TAGS[1]).length, 1);
  // Still metadata-only after paging.
  for (const entry of snapshot.entries) assert.equal("value" in entry, false);
});

test("AC-5: a repeating cursor is refused rather than spun on", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mine-gt-"));
  const out = path.join(dir, "ground-truth.real.json");
  const errs = [];
  const { remote, connection } = pagingRemote(
    { [OUTCOME_TAGS[0]]: rowsFor(OUTCOME_TAGS[0], PAGE_LIMIT + 1, "a") },
    { repeatCursor: true },
  );

  const code = await main(["--confirm", "--out", out], {
    log: () => {},
    err: (m) => errs.push(String(m)),
    deps: { resolveStores: () => ({ remote, connection }) },
  });

  assert.equal(code, 4);
  assert.match(errs.join("\n"), /repeating cursor/);
  // Nothing was written.
  assert.equal(fs.existsSync(out), false);
});

test("AC-6: a value-taking flag never swallows the next flag or an empty value", () => {
  // `--confirm --scope` must not leave scope undefined (which would mine EVERY
  // scope), and `--scope --confirm` must not eat the confirm flag.
  assert.throws(() => parseMineArgs(["--confirm", "--scope"]), /--scope requires a value/);
  assert.throws(() => parseMineArgs(["--scope", "--confirm"]), /--scope requires a value/);
  assert.throws(() => parseMineArgs(["--out"]), /--out requires a value/);
  assert.throws(() => parseMineArgs(["--out", "--confirm"]), /--out requires a value/);
  // Malformed (present but empty) is refused too, not just missing.
  assert.throws(() => parseMineArgs(["--scope", "   "]), /non-empty/);
  assert.throws(() => parseMineArgs(["--out", ""]), /--out requires a non-empty value/);
  // The happy paths still parse.
  assert.equal(parseMineArgs(["--scope", "repo::a/b", "--confirm"]).scope, "repo::a/b");
  assert.equal(parseMineArgs(["--confirm", "--out", "/tmp/x.json"]).out, "/tmp/x.json");
  // A typo'd flag is a usage error, never a silent widening.
  assert.throws(() => parseMineArgs(["--scpoe", "repo::a/b"]), /unknown option/);
});

test("AC-6: main surfaces a bad flag as usage and never reaches the store", async () => {
  const errs = [];
  const code = await main(["--confirm", "--scope"], {
    log: () => {},
    err: (m) => errs.push(String(m)),
    deps: {
      resolveStores: () => {
        throw new Error("resolveStores must not be reached on the usage path");
      },
    },
  });
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /--scope requires a value/);
});

test("AC-5: a string seen_count is mined as a number, not dropped to null", () => {
  // The hosted projection hands `seen_count` back as a string on some paths;
  // `seenCountOf` in src/ground-truth.mjs already accepts one, so redaction must
  // not require a `number` and silently mine `null` (later weighted 0).
  assert.equal(redactToMetadata({ seen_count: "7" }).seenCount, 7);
  assert.equal(redactToMetadata({ seenCount: "3.9" }).seenCount, 3);
  assert.equal(redactToMetadata({ seenCount: "-2" }).seenCount, 0);
  // Absent still stays null — the placeholder tell, not a 0 count.
  assert.equal(redactToMetadata({}).seenCount, null);
  // Present but unparseable degrades to 0, exactly as seenCountOf does.
  assert.equal(redactToMetadata({ seen_count: "not-a-number" }).seenCount, 0);
});

test("AC-6: the service-role acknowledgement flag is READ, and says it did not widen the read", async () => {
  // The flag used to be documented but never read, so setting it changed
  // nothing and the operator could believe a cross-tenant mine had happened.
  const errs = [];
  const prior = process.env[SERVICE_ROLE_ENV];
  process.env[SERVICE_ROLE_ENV] = "1";
  try {
    const code = await main(["--confirm"], {
      log: () => {},
      err: (m) => errs.push(String(m)),
      // No usable remote → returns 3 before any query; the notice must already
      // have been printed by then.
      deps: {
        resolveStores: () => ({ remote: { usable: () => false }, connection: {} }),
      },
    });
    assert.equal(code, 3);
  } finally {
    if (prior === undefined) delete process.env[SERVICE_ROLE_ENV];
    else process.env[SERVICE_ROLE_ENV] = prior;
  }
  const joined = errs.join("\n");
  assert.match(joined, /does NOT implement a cross-tenant/);
  assert.match(joined, /USER-SCOPED/);
});

test("AC-6: with the flag unset there is no service-role notice", async () => {
  const errs = [];
  const prior = process.env[SERVICE_ROLE_ENV];
  delete process.env[SERVICE_ROLE_ENV];
  try {
    await main(["--confirm"], {
      log: () => {},
      err: (m) => errs.push(String(m)),
      deps: {
        resolveStores: () => ({ remote: { usable: () => false }, connection: {} }),
      },
    });
  } finally {
    if (prior !== undefined) process.env[SERVICE_ROLE_ENV] = prior;
  }
  assert.equal(/cross-tenant/.test(errs.join("\n")), false);
});

test("AC-5: a zero-row mine refuses to write an EMPTY baseline", async () => {
  // An empty ground truth scores recall 1 by design ("nothing to miss"), so an
  // empty snapshot stamped `real-hosted-snapshot` would look perfect while
  // measuring nothing — worse than the truncated snapshot the pagination walk
  // prevents, and reachable by an ordinary wrong --scope.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mine-gt-"));
  const out = path.join(dir, "ground-truth.real.json");
  const errs = [];
  const { remote, connection } = pagingRemote({});

  const code = await main(["--confirm", "--out", out], {
    log: () => {},
    err: (m) => errs.push(String(m)),
    deps: { resolveStores: () => ({ remote, connection }) },
  });

  assert.equal(code, 5);
  assert.match(errs.join("\n"), /EMPTY baseline/);
  assert.match(errs.join("\n"), /Nothing was written/);
  assert.equal(fs.existsSync(out), false);
});
