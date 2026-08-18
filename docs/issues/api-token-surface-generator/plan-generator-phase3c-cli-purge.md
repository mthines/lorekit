# Plan — Generator Phase 3c: CLI `purge` / `purge-expired`

> **Plan-only artifact.** Nothing here is implemented. A fresh session executes it later.

## Session bootstrap (read first)

- **Worktree / cwd:** `/Users/mthines/Workspace/lorekit.git/feat/api-token-surface-generator`
  (`gw` worktree of `mthines/lorekit`). Do all work here. **Never** touch/`cd`/`gw clean` `…/main`.
- **Branch:** `feat/api-token-surface-generator` (stack → `…-scope-authorized-removal` → `feat/combobox-multi-select`, PR #490). Confirm with `git branch --show-current`.
- **First action:** verify anchors:
  `ls packages/cli/bin/lorekit.mjs packages/cli/src/store/remote.mjs supabase/functions/memories/handlers/purge.ts packages/mcp-core/src/account-wide-tools.ts packages/schemas/src/tool-catalog.ts`.
- **DEPENDENCY:** land **Phase 2** first (this adds the two CLI commands through
  the catalog `surfaces` bindings so the manifest gate closes the KNOWN-GAP
  exemptions instead of leaving them hand-written).

## Context / background

`memory.purge` and `memory.purge_expired` exist on MCP (`toolPurge`,
`toolPurgeExpired`) and on REST (`POST /memories/purge`, `POST
/memories/purge-expired` — `handlePurge`/`handlePurgeExpired`). There is **no CLI
subcommand** for either. Phase 1's `surface-parity.spec.ts` records both as
explicit `{ exempt: 'KNOWN GAP — … slated for the generator' }` entries; Phase 2
carries them forward as `cliExempt` in the catalog `surfaces` binding. This plan
closes both gaps.

Key facts:
- REST contract (`handlers/purge.ts`): `POST /memories/purge` takes an optional
  body validated by `PurgeMemoriesBodySchema` (`{ retention_days }`, 1–365,
  default 30 via the schema — over HTTP an out-of-range value is a 4xx, not a
  silent clamp). `POST /memories/purge-expired` takes no body. Both return
  `{ purged: <number> }`. Both are rate-limited (429) and support the dry-run
  header. Both require a user-scoped credential (service-role → 403).
- **Account-wide refusal (PRESERVE):** both endpoints call
  `refuseAccountWideSweep(auth, 'memory.purge'|'memory.purge_expired', …)`, which
  uses `isRefusedForScopedKey` from `_shared/account-wide-tools.ts`. A token with a
  non-empty scope allowlist gets a 403 — account-wide sweeps are refused for
  scoped keys. The CLI must NOT try to work around this; it just surfaces the
  server's 403.
- The CLI `remote.mjs` store has **no** `purge`/`purgeExpired` method yet. It must
  gain them, calling `POST /memories/purge` and `/purge-expired`.
- **Local store:** does the offline `.lorekit/` store support purge? Check
  `packages/cli/src/store/local.mjs`. Purge = permanently delete archived rows
  older than N days (and TTL-expired rows). The local store has archive/TTL
  semantics for some ops; decide whether `lorekit purge` supports `--local` or is
  remote-only. Default: purge is a **remote** maintenance op (the RPCs are
  user-scoped server state); a `--local` purge is only meaningful if the local
  store tracks `archived_at`/`expires_at` — confirm and, if not cheaply
  supportable, make purge remote-only with a clear message on `--local` (mirror
  how `bootstrap`/`migrate --to remote` are remote-only).

## Requirements

- **R1** [user-stated] Wire `lorekit purge` and `lorekit purge-expired`
  subcommands over the existing REST `/purge` / `/purge-expired` routes.
- **R2** [user-stated] Preserve the account-wide refusal for scoped keys — a
  scoped `lk_*` token running `lorekit purge` gets the server's 403 surfaced
  clearly, never silently downgraded or worked around.
- **R3** [user-stated] Do it THROUGH the Phase-2 catalog: flip the two
  `cliExempt` KNOWN-GAP bindings to real CLI commands (`purge`, `purge-expired`),
  regenerate the manifest, and let the completeness gate confirm the exemptions
  are gone.
- **R4** [derived] `purge` accepts `--retention-days <1..365>` (default 30,
  matching `PURGE_RETENTION_DAYS_DEFAULT`); `purge-expired` takes no options.
- **R5** [derived] Both are destructive + irreversible — apply a confirmation
  guard: dry-run/confirm by default, `--yes` to apply, `--json` for scripting.
  Mirror `migrate`'s posture (dry-run default, `--yes`/`--apply` to write).
- **R6** [derived] Telemetry inheritance: both commands dispatch via
  `traceCommand` like every other human command (Phase-2 R6 guard covers this).

## Decisions (defaults chosen — CONFIRM)

- **D1 — confirmation posture.** Default: `purge`/`purge-expired` PROMPT for
  confirmation (`y/N`) in an interactive TTY and REQUIRE `--yes` in
  non-interactive / `--json` mode (refuse otherwise). This matches the "destructive
  op should not fire from an agent loop unattended" posture and `migrate`'s
  dry-run-by-default. Alternative: dry-run-by-default (show "would purge N")
  needs a count endpoint the API may not expose — the purge RPCs return the count
  only AFTER deleting, so a true dry-run count is not available; therefore go with
  the confirm-or-`--yes` gate, not a dry-run preview. (The REST dry-run header
  stops before the write and returns nothing useful to preview, so it is not the
  right primitive for a CLI preview.)
- **D2 — remote-only vs `--local`.** Default: remote-first like `write`
  (remote when usable, else a clear message). Support `--local` only if
  `local.mjs` already tracks archived/expired rows cheaply; otherwise `--local`
  prints "purge is a remote maintenance operation" and exits non-zero. Confirm by
  reading `local.mjs` before deciding.
- **D3 — command names + aliases.** `purge` and `purge-expired` (hyphenated,
  matching the REST route + `rest-tool-name.ts` `memory.purge_expired`). No
  aliases. These are new `HUMAN_COMMANDS`.
- **D4 — scoped-key 403 UX.** On a 403 with the account-wide refusal message,
  print the server's message verbatim plus a one-line hint ("use an unscoped
  token for maintenance sweeps") — do not translate it into a generic error.

## Acceptance criteria (verifiable)

- **AC1** (covers R1, R3) The catalog `surfaces` bindings for `memory.purge` /
  `memory.purge_expired` now name real CLI commands (`purge`, `purge-expired`),
  the `cliExempt` KNOWN-GAP reasons are gone, and the Phase-2 completeness/manifest
  gate passes with no exemption for these two.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts` passes.
  - `kind: command`: `grep -n "KNOWN GAP" packages/schemas/src/tool-catalog.ts` no longer matches the purge bindings.
- **AC2** (covers R1) `bin/lorekit.mjs` dispatches both: `case 'purge'` and
  `case 'purge-expired'` exist, both in `HUMAN_COMMANDS`, both wrapped in
  `traceCommand`.
  - `kind: command`: `grep -nE "case 'purge(-expired)?':" packages/cli/bin/lorekit.mjs` shows both.
- **AC3** (covers R1, R4) `remote.mjs` has `purge({ retentionDays })` and
  `purgeExpired()` calling `POST /memories/purge` (with `{ retention_days }` when
  provided) and `POST /memories/purge-expired`, returning `{ ok, purged, error,
  networkError, httpStatus }`.
  - `kind: command`: `node --test packages/cli/test/purge.test.mjs` (new) passes, covering: success returns purged count; 403 account-wide refusal surfaced; 429 rate-limit surfaced; retention-days passthrough.
- **AC4** (covers R2, D4) A scoped-key 403 is surfaced with the server's
  account-wide-refusal message, not a generic failure.
  - `kind: command`: the `purge.test.mjs` case for a mocked 403 asserts the printed/`--json` error contains the refusal message text.
- **AC5** (covers R5, D1) Destructive-confirm guard: `purge`/`purge-expired`
  without `--yes` in non-interactive/`--json` mode refuse; with `--yes` they
  proceed (mocked).
  - `kind: command`: `purge.test.mjs` asserts the refuse-without-`--yes` and
    proceed-with-`--yes` branches.
- **AC6** (covers R4) `--retention-days` is validated 1–365 (reject out of range
  with an actionable error before any request); default 30.
  - `kind: command`: `purge.test.mjs` asserts `--retention-days 0` and `400` are rejected client-side, and the default is 30.
- **AC7** (regression) Full CLI suite green:
  `node --test packages/cli/test/*.test.mjs` (or at least `cli.test.mjs`,
  `purge.test.mjs`, `remove.test.mjs`).
- **AC8** (covers R3) `node scripts/gen-surfaces.mjs --check` and
  `node scripts/sync-edge-schemas.mjs --check` exit 0 after regeneration; the CLI
  local `mcp-server.mjs` is unaffected (purge tools already advertised there? they
  are MCP tools — confirm `MEMORY_TOOL_DEFS`/`MEMORY_DISPATCH` already include
  purge; if not, that is a separate pre-existing gap, note it).

## File changes (concrete paths)

- **Add** `packages/cli/src/purge.mjs` — `purge(args)` and `purgeExpired(args)`,
  mirroring `remove.mjs`'s structure (store pick, confirm/`--yes` guard, `--json`,
  outcome mapping). Reuse `pickStore`-style selection or the existing store
  resolution helpers (`resolveStores`/`resolveDenies` from `stores.mjs`/`control.mjs`).
- **Edit** `packages/cli/src/store/remote.mjs` — add `purge({ retentionDays })`
  and `purgeExpired()` methods (POST to `/memories/purge` / `/purge-expired`,
  passing `{ retention_days }` when set, returning the standard envelope with
  `httpStatus` + `error` so the 403/429 UX works).
- **Edit** `packages/cli/bin/lorekit.mjs`:
  - import `{ purge, purgeExpired } from '../src/purge.mjs'`;
  - `case 'purge': return traceCommand('purge', …)`,
    `case 'purge-expired': return traceCommand('purge-expired', …)`;
  - add `'purge'`, `'purge-expired'` to `HUMAN_COMMANDS`;
  - add `'retention-days'` to `KNOWN_FLAGS`;
  - add `COMMAND_HELP.purge` + `COMMAND_HELP['purge-expired']` entries and mention
    them in the top-level `HELP` Commands list.
- **Edit** `packages/schemas/src/tool-catalog.ts` — flip the two purge `surfaces`
  bindings: `cli:'purge'` / `cli:'purge-expired'`, drop `cliExempt`.
- **Add** `packages/cli/test/purge.test.mjs` — command + store coverage (ACs 3–6).
- **Edit (only if the Phase-2 gate needs it)** the manifest parity spec — no
  change expected beyond removing the exemption, which the catalog edit handles.
- **Regenerate** the surface manifest (`gen-surfaces.mjs`) and, if the CLI reads a
  committed manifest for its command table (Phase-2 D2), regenerate that too.
- **Docs:** `docs/cli.md`, `docs/api-tokens.md` (scoped-key refusal),
  `packages/cli/README.md`, `packages/web/public/llms.txt` (only if it lists CLI
  commands). Run sibling-name docs-drift greps (`purge`, `purge-expired`, and an
  existing sibling like `migrate`).

## Verification

Run from the worktree root. No `timeout` on macOS.

1. `node --test packages/cli/test/purge.test.mjs packages/cli/test/cli.test.mjs packages/cli/test/remove.test.mjs` — green (ACs 2–7). The `purge.test.mjs` mocks `restFetch` (like the existing CLI store tests) so no live backend is needed.
2. `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts` — green (AC1).
3. `node scripts/gen-surfaces.mjs --check` and `node scripts/sync-edge-schemas.mjs --check` — exit 0 (AC8).
4. **Guard-bites proof:** for AC5, confirm removing the `--yes` guard makes the
   refuse-test flip; for AC4, confirm the 403 message passthrough test fails if
   the error is swallowed. Do not commit perturbations.
5. No SQL/isolated-stack run needed — this plan adds no migration and no RPC; the
   server behaviour it calls is already covered by the removal branch's tests and
   the existing purge handler tests. (The account-wide refusal is unit-tested in
   `tenant-scope-usage.spec.ts`'s `account-wide tool guard` describe block, which
   stays green.)

## Risks & mitigations

- **Working around the scoped-key refusal** (e.g. retrying with a different scope
  or splitting the sweep). *Mitigation:* R2/AC4 — surface the 403 verbatim; the
  CLI performs exactly one request and reports the server's answer.
- **A `--local` purge that silently does nothing** because the local store lacks
  archived/expired tracking. *Mitigation:* D2 — read `local.mjs` first; if
  unsupported, make `--local` an explicit refusal, not a no-op success.
- **Unconfirmed destructive run from an agent.** *Mitigation:* D1/AC5 confirm-or-
  `--yes` gate.
- **Out-of-range `--retention-days` sent to the server** (the schema 4xx would be
  a confusing round-trip). *Mitigation:* AC6 validates client-side first.
- **Docs-drift.** *Mitigation:* sibling-name greps before claiming done.

## Dependencies / ordering

- **Depends on Phase 2.** Independent of 3a / 3b / 3d. Smallest of the Phase-3
  plans — good candidate to land immediately after Phase 2 to exercise the manifest
  gate's "close a KNOWN-GAP exemption" path end to end.
