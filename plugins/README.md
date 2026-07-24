# LoreKit plugins

Deterministic shared-memory integrations for three coding agents. All three
share one engine — the `lorekit hook` command in [`@lorekit/cli`](../packages/cli/) —
and differ only in the thin, declarative config that wires it to each host.

```
                    ┌───────────────────────────────┐
  host hook event   │  npx @lorekit/cli hook          │
  (JSON on stdin) ─→│    --adapter <claude|cursor|…>  │─→ inject lessons /
                    │    --event  <SessionStart|…>    │   retrospective nudge
                    │  (scope + MCP fetch + heuristic)│   (JSON on stdout)
                    └───────────────────────────────┘
                                   ↕
                       LoreKit MCP server (memory.*)
```

| Bundle | Read on start | Failure / retrospective | Notes |
|--------|---------------|-------------------------|-------|
| [`lorekit-claude`](./lorekit-claude/) | `SessionStart` hook | `PostToolUseFailure` + `Stop` hooks | Full Claude Code plugin (skill + hooks + MCP). Installable via the marketplace. |
| [`lorekit-cursor`](./lorekit-cursor/) | rule (`beforeSubmitPrompt` best-effort) | `stop` hook | Cursor has no session-start / post-exec-result events; the rule carries the read path. |
| [`lorekit-codex`](./lorekit-codex/) | `SessionStart` hook | `PostToolUse` + `Stop` hooks | Experimental (feature-flagged); `AGENTS.md` fallback included. |

Why one engine and not three copies: every host invokes hooks as an external
process with JSON over stdio, so the logic (scope derivation, MCP fetch,
failure heuristic, retrospective) lives once in the zero-dependency CLI, and
each per-host **adapter** only reshapes input/output to that host's contract.
No build step is required — the CLI is plain ESM.

## Claude Code (marketplace)

```bash
# From this repo (or point at the GitHub repo)
/plugin marketplace add mthines/lorekit
/plugin install lorekit-memory@lorekit
```

Set `LOREKIT_MCP_URL` and `LOREKIT_TOKEN` in your environment, or run
`npx @lorekit/cli install` in the project to write a `.mcp.json`. Then
`npx @lorekit/cli doctor` to verify.

## Cursor / Codex

See each bundle's README for copy-in instructions:
[Cursor](./lorekit-cursor/README.md) · [Codex](./lorekit-codex/README.md).

## Keeping the Claude skill in sync

`lorekit-claude/skills/lorekit-memory/` is vendored from the single source at
`packages/cli/skill/lorekit-memory/`. Re-sync after editing the source:

```bash
node scripts/sync-plugin-skill.mjs        # copy source → plugin
node scripts/sync-plugin-skill.mjs --check # CI: fail if they differ
```
