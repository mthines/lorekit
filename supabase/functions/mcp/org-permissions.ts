/**
 * Org write/delete permission denial translation.
 *
 * The role -> capability matrix (viewer/member/admin/owner x
 * write/archive/restore/hard_delete) lives in EXACTLY ONE place: the
 * `lorekit_org_can` SQL function (supabase/migrations/00016_org_roles_and_author.sql).
 * This module does not re-derive that matrix — it only translates the
 * distinct SQLSTATE the DB raises when a caller is denied (a non-member or a
 * viewer attempting a write-capable action) into an actionable app-layer
 * error, mirroring the limits.ts translation pattern exactly.
 *
 * Import-free (no cross-package imports), so unlike limits.ts it is mirrored
 * verbatim into supabase/functions/mcp/org-permissions.ts and guarded by a
 * whole-file source comparison in edge-parity.spec.ts.
 */

/** Custom SQLSTATE raised by memory_write / memory_delete on an org-permission denial. */
export const ORG_PERMISSION_SQLSTATE = 'LK002';

/** Actionable error surfaced to the caller when an org write/delete is denied by role. */
export class OrgPermissionError extends Error {
  code: 'org_permission_denied';

  constructor(message: string) {
    super(message);
    this.name = 'OrgPermissionError';
    this.code = 'org_permission_denied';
  }
}

/**
 * Translate a DB error into an actionable OrgPermissionError when it was
 * raised by memory_write / memory_delete's org-authorization check
 * (SQLSTATE 'LK002'). Any other error is returned unchanged so callers can
 * rethrow/wrap it as before.
 */
export function translateOrgPermissionError(err: unknown): unknown {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code !== ORG_PERMISSION_SQLSTATE) return err;

  const message =
    (err as { message?: string } | null | undefined)?.message ??
    'org_permission_denied: you do not have the required role in this org';

  return new OrgPermissionError(
    `You don't have permission to do that in this org (${message}). Ask an org admin/owner to change your role.`,
  );
}
