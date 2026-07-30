/**
 * Audit action union + UI metadata — single source of truth for how each
 * `audit_log.action` value is labelled, coloured, and iconified across the
 * dashboard (badge component, filter pills). Adding a new action is a
 * one-line edit here, not a scattered set of if/else branches (mirrors the
 * `scope-meta.ts` single-record pattern).
 *
 * `AUDIT_ACTIONS` / `AuditAction` are NOT declared here — they come from
 * `@lorekit/schemas`, the single source of truth shared with the Node writer
 * (`@lorekit/core`'s `audit.ts`), the Deno writer
 * (`supabase/functions/_shared/audit.ts`) and — restated in SQL — the
 * `audit_log.action` CHECK constraint. They were re-declared here historically
 * to avoid a `@lorekit/core` dependency in `web`; `@lorekit/schemas` is a
 * zero-runtime-dep leaf package (zod only), so it carries none of that weight
 * and the divergence it caused (the dashboard knew 24 actions, the writers 11,
 * the CHECK 23) is now impossible.
 *
 * Both are re-exported so existing `@/lib/audit-actions` importers are
 * unaffected. Only the presentation layer — `AUDIT_ACTION_META` — is owned here;
 * it is deliberately NOT in the schemas package, which must stay free of
 * `lucide-react` and every other UI dependency.
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
  type LucideIcon,
} from 'lucide-react';
import { AUDIT_ACTIONS } from '@lorekit/schemas/audit';
import type { AuditAction } from '@lorekit/schemas/audit';

export { AUDIT_ACTIONS };
export type { AuditAction };

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
};
