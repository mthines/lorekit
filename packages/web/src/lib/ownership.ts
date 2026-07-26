/**
 * Pure derivation of a memory row's ownership badge model.
 *
 * `memories.org_id` (FK `memories_org_id_fkey` → `orgs`, added in 00013) marks
 * a row org-owned; `org_id IS NULL` means personal. The org's *name* isn't on
 * the `memories` row itself — callers embed it via a PostgREST join
 * (`orgs(name, slug)`, see `queries/lore.ts`) and pass both fields here. This
 * function collapses that pair into ONE optional field — `undefined` for
 * personal, `{id, name}` for org-owned — making "org_id set but no org name
 * resolved" collapse to `undefined` (never a half-populated shape) rather
 * than fabricating a placeholder name. Mirrors plan.md Decision D3.
 */

export interface MemoryOwner {
  id: string;
  name: string;
}

export function ownerFromMemoryRow(row: {
  org_id?: string | null;
  org?: { id: string; name: string } | null;
}): MemoryOwner | undefined {
  if (!row.org_id) return undefined;
  if (!row.org) return undefined;
  return { id: row.org.id, name: row.org.name };
}
