/**
 * The ONE translation from a REST `MemoryEntry` to the dashboard's
 * `LessonEntry`.
 *
 * Every read path — the Explorer list, the scope-filtered pages, the legacy
 * whole-dataset fetch — used to carry its own copy of this mapping, each one a
 * hand-written `row.key as string` cast over an untyped PostgREST row. They
 * had already drifted (one populated `id`, another did not; one defaulted
 * `tags` to `[]`, another passed `undefined` through). Now the API returns a
 * typed `MemoryEntry` and this is the only place it becomes a `LessonEntry`,
 * so a field can be added in exactly one place.
 *
 * Pure and dependency-free apart from the two pure helpers it composes, so it
 * is unit-testable in the node vitest project.
 */

import type { MemoryEntry } from '@lorekit/schemas/memory';
import { scopeType } from '@/lib/scope';
import { ownerFromMemoryRow } from '@/lib/ownership';
import type { LessonEntry } from '@/components/lore/LessonCard';

export function lessonFromMemoryEntry(entry: MemoryEntry): LessonEntry & { id: string } {
  const orgId = entry.org_id ?? null;
  const org = entry.org ?? null;

  return {
    id: entry.id,
    scope: entry.scope,
    scope_type: scopeType(entry.scope),
    key: entry.key,
    value: entry.value,
    tags: entry.tags ?? [],
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    archived_at: entry.archived_at ?? null,
    expires_at: entry.expires_at ?? null,
    source_agent: entry.source_agent ?? null,
    trigger: entry.trigger ?? null,
    origin_repo: entry.origin_repo ?? null,
    origin_branch: entry.origin_branch ?? null,
    origin_commit: entry.origin_commit ?? null,
    origin_pr: entry.origin_pr ?? null,
    org_id: orgId,
    created_by: entry.created_by ?? null,
    updated_by: entry.updated_by ?? null,
    // `undefined` (not null) for personal lore — see `ownerFromMemoryRow`.
    org: ownerFromMemoryRow({
      org_id: orgId,
      org: org && orgId ? { id: org.id, name: org.name } : null,
    }),
  };
}
