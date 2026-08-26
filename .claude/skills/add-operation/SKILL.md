---
name: add-operation
description: >
  Points to the single how-to for adding a new LoreKit operation — an MCP
  tool, CLI command, or REST route — across the tool catalog, both permission
  mirrors, the audit vocabulary, and docs. Thin skill; the procedure lives in
  docs/adding-an-operation.md, never duplicated here. Triggers on "add a
  tool", "add a command", "add an operation", "expose a capability",
  "/add-operation".
argument-hint: '[operation name]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: reference
  tags:
    - tool-catalog
    - mcp
    - cli
    - rest
    - lorekit
---

# Add Operation

LoreKit's operation surface (which MCP tools, CLI commands, and REST routes
exist, and how each is bound) is declared once in
`packages/schemas/src/shared/tool-catalog.ts` and projected/mirrored out to
every runtime that cannot import it directly. Adding a new operation touches
that catalog plus up to eight other files, in a specific order, each guarded
by a specific test — get the order wrong and a gate catches it late, or (for
the audit vocabulary, which fails silently) not at all.

**Read [`docs/adding-an-operation.md`](../../../docs/adding-an-operation.md)
end to end before writing any code.** That document — not this skill — is the
source of truth: the surface-decision step (`cliExempt`/`localMcpExempt`), the
ordered checklist (catalog → regen → pure core → edge handler → REST route →
CLI → permissions (both mirrors) → audit vocabulary → docs), the gate table,
and a worked example. This skill exists only so "add a tool" / "add a
command" / "add an operation" / "expose a capability" reliably finds that
document — do not duplicate its content here, and do not improvise a
different order.

## When to use this

- Adding a new MCP tool (`memory.*`, `org.*`, or a new family).
- Adding a new `lorekit` CLI subcommand.
- Adding a new REST route to an existing edge function.
- Any combination of the above for one capability.

## What this skill does

1. Loads `docs/adding-an-operation.md`.
2. Confirms which surfaces (MCP / CLI / REST) the new operation needs, and
   whether any absence needs a `cliExempt`/`localMcpExempt` justification.
3. Walks the ordered checklist in that document, file by file.
4. Runs the gate table in that document's "Gates that catch a missed step"
   section before calling the work done.

If you are inside the `autonomous-workflow` skill's Full Mode, this maps onto
Phase 3 (implementation) — follow this skill's steps as the technical
approach, and let Phase 4's `checks.yaml` gate on the same tests.
