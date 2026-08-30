/**
 * Audit action union + UI metadata — single source of truth for how each
 * `audit_log.action` value is labelled, coloured, and iconified across the
 * dashboard (badge component, filter pills). Adding a new action is a
 * one-line edit here, not a scattered set of if/else branches (mirrors the
 * `scope-meta.ts` single-record pattern).
 *
 * Re-declares the `AuditAction` union independently of `packages/mcp-core/src/audit/audit.ts`
 * (and its self-contained edge copy) — the web package has no dependency on
 * `@lorekit/core` (same reason `lib/scope.ts` re-declares a lightweight copy
 * of `scopeType`), so the action literals are re-declared here rather than
 * imported. This set is a superset of the edge union: it additionally covers
 * the dashboard-only `org.*` / `member.*` actions the edge function never emits.
 */

import {
  KeyRound,
  KeySquare,
  Webhook,
  RefreshCw,
  WebhookOff,
  FilePlus,
  FilePen,
  Archive,
  ArchiveRestore,
  Trash2,
  Gauge,
  Building2,
  PenLine,
  Building,
  UserPlus,
  UserCheck,
  UserX,
  Ban,
  UserMinus,
  ShieldCheck,
  LogOut,
  Link,
  Unlink,
  Github,
  ListChecks,
  ShieldPlus,
  type LucideIcon,
} from 'lucide-react';

export const AUDIT_ACTIONS = [
  'api_key.create',
  'api_key.revoke',
  'api_key.scope_change',
  'webhook_secret.create',
  'webhook_secret.rotate',
  'webhook_secret.deactivate',
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'limit.override',
  'org.create',
  'org.rename',
  'org.delete',
  'member.invite',
  'member.accept',
  'member.decline',
  'member.revoke',
  'member.remove',
  'member.role_change',
  'member.leave',
  'scope.bind',
  'scope.unbind',
  'github_app.installation_linked',
  'policy.create',
  'policy.update',
  'policy.delete',
  'memory.protect',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActionMeta {
  /** Human-readable label for the action badge. */
  label: string;
  /** Badge colour bucket — reuses the same semantic palette as ScopeBadge. */
  badgeColor: 'blue' | 'green' | 'amber' | 'red' | 'purple';
  icon: LucideIcon;
}

/** The single source of truth for every audit action's badge presentation. */
export const AUDIT_ACTION_META: Record<AuditAction, AuditActionMeta> = {
  'api_key.create': { label: 'API key created', badgeColor: 'green', icon: KeyRound },
  'api_key.revoke': { label: 'API key revoked', badgeColor: 'red', icon: KeySquare },
  'api_key.scope_change': { label: 'API key scoping changed', badgeColor: 'blue', icon: KeyRound },
  'webhook_secret.create': { label: 'Webhook secret created', badgeColor: 'green', icon: Webhook },
  'webhook_secret.rotate': { label: 'Webhook secret rotated', badgeColor: 'blue', icon: RefreshCw },
  'webhook_secret.deactivate': { label: 'Webhook secret deactivated', badgeColor: 'red', icon: WebhookOff },
  'memory.create': { label: 'Memory created', badgeColor: 'green', icon: FilePlus },
  'memory.update': { label: 'Memory updated', badgeColor: 'blue', icon: FilePen },
  'memory.archive': { label: 'Memory archived', badgeColor: 'amber', icon: Archive },
  'memory.restore': { label: 'Memory restored', badgeColor: 'blue', icon: ArchiveRestore },
  'memory.delete': { label: 'Memory deleted', badgeColor: 'red', icon: Trash2 },
  'limit.override': { label: 'Limit overridden', badgeColor: 'purple', icon: Gauge },
  'org.create': { label: 'Organization created', badgeColor: 'green', icon: Building2 },
  'org.rename': { label: 'Organization renamed', badgeColor: 'blue', icon: PenLine },
  'org.delete': { label: 'Organization deleted', badgeColor: 'red', icon: Building },
  'member.invite': { label: 'Member invited', badgeColor: 'green', icon: UserPlus },
  'member.accept': { label: 'Invite accepted', badgeColor: 'green', icon: UserCheck },
  'member.decline': { label: 'Invite declined', badgeColor: 'amber', icon: UserX },
  'member.revoke': { label: 'Invite revoked', badgeColor: 'red', icon: Ban },
  'member.remove': { label: 'Member removed', badgeColor: 'red', icon: UserMinus },
  'member.role_change': { label: 'Member role changed', badgeColor: 'blue', icon: ShieldCheck },
  'member.leave': { label: 'Member left', badgeColor: 'amber', icon: LogOut },
  'scope.bind': { label: 'Scope bound', badgeColor: 'green', icon: Link },
  'scope.unbind': { label: 'Scope unbound', badgeColor: 'amber', icon: Unlink },
  'github_app.installation_linked': { label: 'GitHub App installation linked', badgeColor: 'green', icon: Github },
  'policy.create': { label: 'Retention policy created', badgeColor: 'green', icon: ListChecks },
  'policy.update': { label: 'Retention policy updated', badgeColor: 'blue', icon: ListChecks },
  'policy.delete': { label: 'Retention policy deleted', badgeColor: 'red', icon: ListChecks },
  'memory.protect': { label: 'Memory protection changed', badgeColor: 'purple', icon: ShieldPlus },
};
