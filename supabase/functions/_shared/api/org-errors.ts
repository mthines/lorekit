/**
 * Org permission error translation for REST Edge Functions.
 * Mirrors the logic in mcp/org-permissions.ts.
 */

export const ORG_PERMISSION_SQLSTATE = 'LK002';

export class OrgPermissionError extends Error {
  code: 'org_permission_denied';
  constructor(message: string) {
    super(message);
    this.name = 'OrgPermissionError';
    this.code = 'org_permission_denied';
  }
}

export function translateOrgPermissionError(err: unknown): OrgPermissionError | unknown {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code !== ORG_PERMISSION_SQLSTATE) return err;
  const message = (err as { message?: string })?.message ?? 'Permission denied';
  return new OrgPermissionError(message);
}
