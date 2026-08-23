#!/usr/bin/env node
// `mine-ground-truth` — the one-shot, MANUAL step that turns the placeholder
// retrieval-relevance baseline into a real one.
//
// It queries the HOSTED store for the outcome/relevance-tagged memories
// (`loop::review-outcomes`, `loop::reviewer-comment-relevance`) and freezes a
// METADATA-ONLY snapshot at `fixtures/ground-truth.real.json` — scope, key,
// tags, origin_pr, seenCount, and NOTHING ELSE. No lesson body ever leaves the
// hosted store through this script.
//
// It is deliberately NOT wired into any CI job, npm script, nx target or
// `node --test` file: `AC-7-nowire` greps to keep it that way. A bare run prints
// usage and the placeholder→real explanation and exits non-zero; a real run
// requires BOTH `--confirm` AND a usable remote connection. This is the
// executable form of "the committed baseline is a placeholder until someone
// deliberately mines the real one".
//
// REUSE, NOT A NEW CLIENT. The query goes through the CLI's shipped remote store
// (`resolveStores` → `remote.list({ scope, tags })`), which is the same
// server-side `overlaps('tags', …)` path the product uses. That store is always
// USER-SCOPED (the CLI token is), and this script does NOT implement a
// cross-tenant read: a maintainer who needs one wires `@lorekit/mcp-core`'s
// `createHostedAdapter` (SUPABASE_SERVICE_ROLE_KEY) by hand per the README
// runbook, because a service-role read can surface OTHER users' rows and that
// must be an explicit choice, never the happy path.
//
// LOREKIT_GROUND_TRUTH_SERVICE_ROLE=1 is therefore an ACKNOWLEDGEMENT flag, not
// a switch. Setting it does not widen the read; the script says so out loud
// (`SERVICE_ROLE_NOTICE`) rather than letting an operator believe a cross-tenant
// mine happened when a user-scoped one did.
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { seenCountOf } from "../src/relevance/ground-truth.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
export const REAL_SNAPSHOT_PATH = path.join(FIXTURES, "ground-truth.real.json");

/** The two loop tags that define the outcome/relevance signal, ANY-matched. */
export const OUTCOME_TAGS = [
  "loop::review-outcomes",
  "loop::reviewer-comment-relevance",
];

/** Rows per `remote.list` page, and the page ceiling the cursor walk refuses past. */
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 100;

/** The ONLY fields a mined entry may carry. A lesson body is never among them. */
export const METADATA_FIELDS = ["scope", "key", "tags", "origin_pr", "seenCount"];

/**
 * Project a store row down to the metadata-only shape. Anything not in
 * METADATA_FIELDS — crucially `value`/`body` — is dropped here, at the one choke
 * point every emitted entry passes through.
 */
export function redactToMetadata(row) {
  // ABSENT stays `null` (the placeholder tell: the seed carries no count at
  // all), but a PRESENT count is read with the same coercion `seenCountOf`
  // applies — the hosted projection hands `seen_count` back as a string on some
  // paths, and a local re-implementation that required a `number` mined it as
  // `null` and had it later weighted 0.
  const raw = row?.seenCount ?? row?.seen_count ?? null;
  return {
    scope: row?.scope ?? null,
    key: row?.key ?? null,
    tags: Array.isArray(row?.tags) ? [...row.tags] : [],
    origin_pr: row?.origin_pr ?? null,
    seenCount: raw == null ? null : seenCountOf({ seenCount: raw }),
  };
}

// Secret-shaped patterns. Deliberately broad — this runs on METADATA that should
// never contain a credential in the first place, so a false positive (which
// aborts the write) is far cheaper than leaking one. It is the backstop behind
// `redactToMetadata`, not the primary defence.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email (PII)
];

/**
 * The privacy pre-flight. Runs on the ENTRIES ABOUT TO BE WRITTEN, and throws —
 * aborting the whole write — if any entry:
 *   1. still carries a body key (`value`/`body`) that redaction should have
 *      dropped, or any key outside METADATA_FIELDS; or
 *   2. contains a secret-shaped or PII-shaped string in any of its values.
 *
 * Returns the entries unchanged on success so it reads as a pass-through guard:
 * `write(privacyPreflight(entries))`.
 */
export function privacyPreflight(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const allowed = new Set(METADATA_FIELDS);
  for (const [i, entry] of list.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`privacyPreflight: entry ${i} is not an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key === "value" || key === "body") {
        throw new Error(
          `privacyPreflight: entry ${i} (${entry.key}) still carries a "${key}" — lesson bodies must never be emitted`,
        );
      }
      if (!allowed.has(key)) {
        throw new Error(
          `privacyPreflight: entry ${i} (${entry.key}) carries a non-metadata field "${key}"; only ${METADATA_FIELDS.join(", ")} are permitted`,
        );
      }
    }
    const haystack = JSON.stringify(entry);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(haystack)) {
        throw new Error(
          `privacyPreflight: entry ${i} (${entry.key}) contains a secret/PII-shaped string matching ${pattern} — refusing to write`,
        );
      }
    }
  }
  return list;
}

const USAGE = `mine-ground-truth — freeze a real retrieval-relevance baseline from the hosted store

  This is a MANUAL, one-shot maintenance step. It is not run by CI, by any npm
  script, or by \`node --test\`.

  What it does:
    Queries the hosted LoreKit store for outcome/relevance-tagged memories
    (${OUTCOME_TAGS.join(", ")}) and writes a METADATA-ONLY snapshot
    (scope, key, tags, origin_pr, seenCount — never the lesson body) to
    fixtures/ground-truth.real.json, after a privacy pre-flight.

  Placeholder → real:
    Until this script has run, the harness scores against the 2-row BOOTSTRAP
    PLACEHOLDER seed (fixtures/ground-truth.seed.json). Those numbers MUST NOT be
    used to gate downstream PRs (A1/A4). Running this script against the hosted
    store and committing fixtures/ground-truth.real.json is the step — and the
    only step — that turns the placeholder baseline into a real one.

  Usage:
    node bin/mine-ground-truth.mjs --confirm [--scope <repo::owner/name>] [--out <path>]

    --confirm   Required. Without it, nothing is queried or written.
    --scope     Repo scope to mine (default: repo::mthines/lorekit).
    --out       Output path (default: fixtures/ground-truth.real.json).

  A usable remote connection is required (run \`lorekit install\` or set
  LOREKIT_MCP_URL + LOREKIT_TOKEN). The read is ALWAYS user-scoped: this script
  does not implement a cross-tenant service-role read, and
  LOREKIT_GROUND_TRUTH_SERVICE_ROLE=1 only acknowledges that intent — the
  \`createHostedAdapter\` wiring is manual (see the README runbook).
`;

/** The env var that acknowledges cross-tenant intent, and the notice it earns. */
export const SERVICE_ROLE_ENV = "LOREKIT_GROUND_TRUTH_SERVICE_ROLE";
export const SERVICE_ROLE_NOTICE =
  `${SERVICE_ROLE_ENV}=1 is set, but this script does NOT implement a cross-tenant ` +
  "service-role read — the mine below is USER-SCOPED via the CLI token. Wire " +
  "@lorekit/mcp-core's createHostedAdapter (SUPABASE_SERVICE_ROLE_KEY) by hand per " +
  "the README runbook if you need one.";

/**
 * Is `raw` a missing value for a value-taking flag — end of argv, or the NEXT
 * flag? `--confirm --scope` must not leave `scope` undefined (which would mine
 * EVERY scope), and `--scope --confirm` must not swallow the confirm flag.
 * A value-taking flag that consumes the next FLAG is wrong regardless of how
 * safe its own default happens to be.
 */
function isMissingValue(raw) {
  return raw === undefined || (typeof raw === "string" && raw.startsWith("-"));
}

/**
 * Minimal, dependency-free arg parse.
 *
 * Every value-taking flag answers the same three questions, so no sibling is
 * left behind: is a value PRESENT (`isMissingValue`), is it WELL-FORMED for this
 * flag (non-empty), and is the flag itself RECOGNISED (the `else` throw closes
 * the set, so a typo like `--scpoe` is a usage error, never a silent widening).
 */
export function parseMineArgs(argv = []) {
  const out = {
    confirm: false,
    scope: "repo::mthines/lorekit",
    out: REAL_SNAPSHOT_PATH,
  };
  const valueFor = (flag, raw) => {
    if (isMissingValue(raw)) {
      throw new Error(`${flag} requires a value`);
    }
    if (raw.trim() === "") {
      throw new Error(`${flag} requires a non-empty value`);
    }
    return raw;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm") out.confirm = true;
    else if (a === "--scope") out.scope = valueFor("--scope", argv[++i]);
    else if (a === "--out") out.out = valueFor("--out", argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown option "${a}"`);
  }
  return out;
}

/**
 * Entry point. Returns a process exit code (never calls `process.exit` itself so
 * it stays testable). Prints to the injected `log`/`err` sinks (default
 * console) so a test can assert on output with no capture plumbing.
 *
 * IMPORTANT: with no `--confirm`, this returns BEFORE resolving any store or
 * touching the network — the refusal is pure argument validation, so `main([])`
 * in a test with no token configured makes zero network calls.
 */
export async function main(
  argv = [],
  { log = console.log, err = console.error, deps = {} } = {},
) {
  let args;
  try {
    args = parseMineArgs(argv);
  } catch (e) {
    err(String(e.message));
    err(USAGE);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!args.confirm) {
    err(
      "Refusing to run without --confirm. This script mines a REAL baseline from the hosted store.",
    );
    err(USAGE);
    return 2;
  }

  // The acknowledgement flag is READ, so setting it is never silently inert —
  // it earns an explicit "this did not widen the read" notice.
  if (process.env[SERVICE_ROLE_ENV]) {
    err(SERVICE_ROLE_NOTICE);
  }

  // Only now do we reach for the store. Import lazily so the refusal path above
  // never even loads the CLI store module.
  const { resolveStores } =
    deps.resolveStores
      ? { resolveStores: deps.resolveStores }
      : await import("@lorekit/cli/src/stores.mjs");

  const { remote, connection } = resolveStores(process.cwd(), {
    env: process.env,
  });
  if (!remote || !remote.usable()) {
    err(
      `No usable remote connection (endpoint=${connection?.endpoint ?? "none"}). ` +
        "Run `lorekit install` or set LOREKIT_MCP_URL + LOREKIT_TOKEN. Nothing was written.",
    );
    return 3;
  }

  // Query each outcome tag and union the rows (server-side ANY match would also
  // work; querying per-tag keeps the intent explicit and the round-trips small).
  //
  // PAGINATED. `remote.list` caps a page at `limit` and reports `hasMore` +
  // `nextCursor`; reading only the first page would freeze a SILENTLY TRUNCATED
  // snapshot whose header calls it safe to gate PRs on. The cursor walk mirrors
  // `gatherStream` in `@lorekit/cli/src/lessons-view.mjs` — the same
  // `!hasMore || !nextCursor → stop` termination the read commands use, so a
  // local store (which returns everything in one page and no cursor) still ends
  // after one iteration.
  const byKey = new Map();
  for (const tag of OUTCOME_TAGS) {
    let cursor;
    let pages = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await remote.list({
        scope: args.scope,
        tags: [tag],
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!res || res.ok === false) {
        err(`remote.list failed for tag ${tag}: ${res?.error ?? "unknown error"}`);
        return 4;
      }
      for (const row of res.entries ?? []) {
        byKey.set(`${row.scope}::${row.key}`, row);
      }
      pages += 1;
      if (!res.hasMore || !res.nextCursor) break;
      // A server that repeats a cursor would spin forever; refuse rather than
      // hang, and refuse rather than write a snapshot we know is partial.
      if (res.nextCursor === cursor) {
        err(
          `remote.list returned a repeating cursor for tag ${tag}; refusing to write a possibly partial snapshot.`,
        );
        return 4;
      }
      if (pages >= MAX_PAGES) {
        err(
          `remote.list still reports more rows for tag ${tag} after ${MAX_PAGES} pages (${PAGE_LIMIT}/page). ` +
            "Refusing to write a TRUNCATED snapshot — narrow --scope and re-run.",
        );
        return 4;
      }
      cursor = res.nextCursor;
    }
  }

  const redacted = [...byKey.values()].map(redactToMetadata);
  const entries = privacyPreflight(redacted); // throws → abort before any write

  // The THIRD way this snapshot can be untrustworthy, alongside truncated and
  // partial: EMPTY. An empty baseline is worse than a truncated one, because
  // `recallAtK` returns 1 for an empty ground truth ("nothing to miss") — so a
  // zero-row mine would score PERFECTLY, stamped `real-hosted-snapshot`, with no
  // warning anywhere. Nothing is written; the operator gets the two ordinary
  // causes to check.
  if (entries.length === 0) {
    err(
      `No outcome/relevance rows found for scope ${args.scope} (tags: ${OUTCOME_TAGS.join(", ")}). ` +
        "Refusing to write an EMPTY baseline — it would score a perfect recall against nothing. " +
        "Check --scope, and that this token can see those rows. Nothing was written.",
    );
    return 5;
  }

  const snapshot = {
    _README:
      "REAL retrieval-relevance baseline mined from the hosted store. Metadata only — no lesson bodies. Safe to commit and to gate downstream PRs against, subject to review.",
    source: "real-hosted-snapshot",
    scope: args.scope,
    minedAt: new Date().toISOString(),
    entries,
  };
  await fsp.writeFile(args.out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  log(
    `Wrote ${entries.length} metadata-only entries to ${args.out} (source: real-hosted-snapshot).`,
  );
  return 0;
}

// Only auto-run when invoked directly, never on import.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
