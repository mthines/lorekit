# LoreKit for Codex CLI

> ⚠️ **Experimental.** Codex hooks require the `codex_hooks` feature flag, are
> disabled on Windows, and first shipped in Codex v0.114 (2026). Codex mirrors
> Claude Code's hook event model, so LoreKit reuses the same adapter — but the
> exact config key layout can vary between Codex versions. If a hook does not
> fire, check the Codex docs and adjust `config.toml.example` / `hooks.json`.

## Install

1. Merge `config.toml.example` into `~/.codex/config.toml` (feature flag, the
   `lorekit` MCP server, and the three hooks). Fill in your endpoint + token.
2. Or, if your Codex build reads a standalone `hooks.json`, use `hooks.json`
   here instead of the `[hooks.*]` tables.
3. Append `AGENTS.snippet.md` to your project's `AGENTS.md`. This is the
   reliable fallback for builds without hooks and reinforces the behavior when
   hooks are enabled.

Hooks call `npx -y @lorekit/cli`; `npm i -g @lorekit/cli` lowers latency.
Verify the connection with `npx @lorekit/cli doctor`.

## What fires

| Event | Behavior |
|-------|----------|
| `SessionStart` | Injects scoped lessons read from LoreKit |
| `PostToolUse` | On a detected tool failure, nudges the agent to record a lesson (once per session) |
| `Stop` | Injects the retrospective nudge (once per session) |
