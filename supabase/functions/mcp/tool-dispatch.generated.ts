// GENERATED — do not edit.
// Source: packages/schemas/src/shared/tool-catalog.ts
// Regenerate: node scripts/codegen/gen-surfaces.mjs
//
// Edit the catalog's `surfaces` bindings, not this file. `--check` fails CI
// when the two disagree.

import {
  toolWrite,
  toolRead,
  toolList,
  toolDelete,
  toolSearch,
  toolArchive,
  toolScopes,
  toolListArchived,
  toolRestore,
  toolPurge,
  toolPurgeExpired,
  toolOrgCreate,
  toolOrgList,
  toolOrgRename,
  toolOrgDelete,
  toolPolicyList,
  toolPolicyCreate,
  toolPolicyUpdate,
  toolPolicyDelete,
  toolGroomPreview,
  toolGroomRun,
  toolProtect,
} from './tools.ts';
import type { MemoryToolName, OrgToolName, RetentionToolName } from '../_shared/schemas/tool-catalog.ts';

// memory.* tools — dispatched with (db, args, userId, span, keyScoping).
export const MEMORY_TOOLS = {
  'memory.write': toolWrite,
  'memory.read': toolRead,
  'memory.list': toolList,
  'memory.delete': toolDelete,
  'memory.search': toolSearch,
  'memory.archive': toolArchive,
  'memory.scopes': toolScopes,
  'memory.list_archived': toolListArchived,
  'memory.restore': toolRestore,
  'memory.purge': toolPurge,
  'memory.purge_expired': toolPurgeExpired,
  'memory.protect': toolProtect,
} as const satisfies Record<MemoryToolName, unknown>;

// org.* tools — dispatched with (db, args, userId, span), the same shape as
// the memory family so the dispatcher threads the actor one way.
export const ORG_TOOLS = {
  'org.create': toolOrgCreate,
  'org.list': toolOrgList,
  'org.rename': toolOrgRename,
  'org.delete': toolOrgDelete,
} as const satisfies Record<OrgToolName, unknown>;

// policy.*/groom.* tools — dispatched with (db, args, userId, span,
// keyScoping), where userId is the RESOLVED owner (analyticsUserId), never
// the JWT-null toolUserId: the underlying lorekit_policy_*/lorekit_groom_*
// RPCs take p_user_id explicitly and have no auth.uid() fallback. keyScoping
// is the calling key's restriction (00068) — each handler gates the scope it
// resolves (create's target scope; update/delete's pre-fetched STORED scope;
// list's narrowing; groom's resolved conditions.scope) against it, mirroring
// how the memory family threads the same argument.
export const RETENTION_TOOLS = {
  'policy.list': toolPolicyList,
  'policy.create': toolPolicyCreate,
  'policy.update': toolPolicyUpdate,
  'policy.delete': toolPolicyDelete,
  'groom.preview': toolGroomPreview,
  'groom.run': toolGroomRun,
} as const satisfies Record<RetentionToolName, unknown>;

/** Every dispatchable name — the unknown-tool guard in `tools/call`. */
export const ALL_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(MEMORY_TOOLS),
  ...Object.keys(ORG_TOOLS),
  ...Object.keys(RETENTION_TOOLS),
]);
