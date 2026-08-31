'use client';

/**
 * The `off` arm of `lore-explorer-duplicate-clusters` — the panel is absent.
 *
 * Renders nothing, and it is a whole component rather than a `null` literal
 * inlined into the resolver for two reasons the convention is built on:
 *
 *  1. **The arms stay symmetric.** Retiring the flag is "delete this file",
 *     which is a complete instruction. An inlined `null` would make it "read the
 *     resolver and work out what was reachable".
 *  2. **`off` is a real, nameable state.** Today its content is nothing; if it
 *     ever becomes a placeholder or an upsell, that lands here rather than
 *     growing a branch inside a component that was supposed to be gone.
 *
 * "Absent", not "hidden": nothing mounts, so no query runs, no preference is
 * read, and the panel is invisible in the DOM as well as on screen.
 */

export function DuplicateClustersPanelOff() {
  return null;
}
