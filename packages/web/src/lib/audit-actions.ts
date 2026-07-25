/**
 * Audit action union + UI metadata — single source of truth for how each
 * `audit_log.action` value is labelled, coloured, and iconified across the
 * dashboard (badge component, filter pills). Adding a new action is a
 * one-line edit here, not a scattered set of if/else branches (mirrors the
 * `scope-meta.ts` single-record pattern).
 *
 * Mirrors the `AuditAction` union defined in `packages/mcp-core/src/audit.ts`
 * (and its self-contained edge copy) — the web package has no dependency on
 * `@lorekit/core` (same reason `lib/scope.ts` re-declares a lightweight copy
 * of `scopeType`), so the 11 action literals are re-declared here rather than
 * imported.
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
  type LucideIcon,
} from 'lucide-react';

export const AUDIT_ACTIONS = [
  'api_key.create',
  'api_key.revoke',
  'webhook_secret.create',
  'webhook_secret.rotate',
  'webhook_secret.deactivate',
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'limit.override',
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
  'webhook_secret.create': { label: 'Webhook secret created', badgeColor: 'green', icon: Webhook },
  'webhook_secret.rotate': { label: 'Webhook secret rotated', badgeColor: 'blue', icon: RefreshCw },
  'webhook_secret.deactivate': { label: 'Webhook secret deactivated', badgeColor: 'red', icon: WebhookOff },
  'memory.create': { label: 'Memory created', badgeColor: 'green', icon: FilePlus },
  'memory.update': { label: 'Memory updated', badgeColor: 'blue', icon: FilePen },
  'memory.archive': { label: 'Memory archived', badgeColor: 'amber', icon: Archive },
  'memory.restore': { label: 'Memory restored', badgeColor: 'blue', icon: ArchiveRestore },
  'memory.delete': { label: 'Memory deleted', badgeColor: 'red', icon: Trash2 },
  'limit.override': { label: 'Limit overridden', badgeColor: 'purple', icon: Gauge },
};
