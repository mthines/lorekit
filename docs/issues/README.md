# API-token surface consistency — execution plans

Resumable plans for making LoreKit's token-capable operation surface consistent
across **MCP, CLI, and REST**, plus finalizing the scope-authorized-removal work.
Each plan is self-contained: it opens with a "read first — you have no memory of
the planning conversation" bootstrap (worktree path, branch stack, first actions),
so a fresh session can execute it cold.

**Ordering:** the generator **Phase 2** must land before Phases 3a–3d (those edit
*through* the catalog surface-bindings Phase 2 introduces). The scope-authorized
removal finalize can run in parallel on its own worktree.

## Surface generator — branch `feat/api-token-surface-generator`
- [Phase 2 — catalog-driven surface codegen](api-token-surface-generator/plan-generator-phase2-codegen.md) — **do first**
- [Phase 3a — org token-enablement (via the catalog)](api-token-surface-generator/plan-generator-phase3a-org-token-enablement.md)
- [Phase 3b — org members + invites on MCP/CLI](api-token-surface-generator/plan-generator-phase3b-org-members-invites.md)
- [Phase 3c — CLI purge / purge-expired](api-token-surface-generator/plan-generator-phase3c-cli-purge.md)
- [Phase 3d — analytics reads (decision record)](api-token-surface-generator/plan-generator-phase3d-analytics-decision.md)

## Scope-authorized removal — branch `feat/api-token-scope-authorized-removal`
- [Finalize → draft PR (stacked on #490) + BYOD follow-up](api-token-scope-authorized-removal/plan-finalize-removal-branch-pr.md)
