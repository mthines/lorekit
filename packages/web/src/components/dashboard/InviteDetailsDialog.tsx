'use client';

/**
 * InviteDetailsDialog — lets a pending (not-yet-member) invitee review WHICH
 * org invited them — name, slug, creation date, the role being granted, the
 * inviter's handle/avatar, and an aggregate member count — before accepting.
 * Opened from `PendingInvitesBanner`'s "View details" affordance.
 *
 * Bespoke rather than an extension of `ConfirmDialog`: this needs a richer
 * content block plus TWO primary actions (Accept/Decline), not one
 * confirm/cancel pair. It reuses `ConfirmDialog`'s a11y patterns verbatim —
 * focus-on-open, Tab-trapped focus, Escape-to-close, `role="dialog"` +
 * `aria-modal`, `min-h-11` targets (plan.md Decisions / Requirement 8).
 *
 * Accept/Decline are wired to the SAME `onAccept`/`onDecline` callbacks the
 * banner passes down (its existing `handleAccept`/`handleDecline`) — there is
 * no second, divergent accept path. Accepting from here therefore preserves
 * the banner's route-to-Explorer + success-toast behavior exactly (AC-7).
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Building2, Loader2, ShieldQuestion, X } from 'lucide-react';
import { getInviteOrgDetails, type OrgInvite, type InviteOrgDetails } from '@/lib/org-invites';
import { memberCountLabel, inviteExpiryLabel } from '@/lib/org-ui';

const ROLE_LABEL: Record<OrgInvite['role'], string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

// Only render an avatar <img> when the URL is a GitHub avatar host — the same
// defense-in-depth gate OrganizationManager applies to resolved member
// avatars (both ultimately come from OAuth-provider-set `raw_user_meta_data`,
// not user-editable via our app).
function isTrustedAvatarUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).hostname === 'avatars.githubusercontent.com';
  } catch {
    return false;
  }
}

function formatOrgCreatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface InviteDetailsDialogProps {
  /** The invite to show details for; the dialog is open iff this is non-null. */
  invite: OrgInvite | null;
  /** True while an accept/decline request is in flight (disables both actions). */
  pending: boolean;
  onClose: () => void;
  onAccept: (invite: OrgInvite) => void;
  onDecline: (invite: OrgInvite) => void;
}

type FetchStatus = 'idle' | 'loading' | 'loaded' | 'error';

export function InviteDetailsDialog({ invite, pending, onClose, onAccept, onDecline }: InviteDetailsDialogProps) {
  const open = invite !== null;
  const [details, setDetails] = useState<InviteOrgDetails | null>(null);
  const [status, setStatus] = useState<FetchStatus>('idle');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Fetch details whenever a new invite is shown. Details fetch failures
  // (network, or the invite is no longer addressed to the caller) degrade to
  // a neutral error state — Accept/Decline don't depend on details, so they
  // remain usable either way (plan.md Edge Cases).
  useEffect(() => {
    if (!invite) {
      setDetails(null);
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    setDetails(null);
    getInviteOrgDetails(invite.id)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setDetails(result);
          setStatus('loaded');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [invite]);

  // Focus-on-open (move to the safe Close action) + restore-on-close.
  // Mirrors ConfirmDialog.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => closeRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open]);

  // Escape closes; Tab / Shift+Tab are trapped within the dialog. Mirrors
  // ConfirmDialog's focus-trap implementation exactly.
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const expiryLabel = invite ? inviteExpiryLabel(invite.expires_at, new Date()) : null;
  const avatarUrl = isTrustedAvatarUrl(details?.inviter_avatar_url) ? details.inviter_avatar_url : null;

  return (
    <AnimatePresence>
      {open && invite && (
        <>
          <motion.div
            key="invite-details-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            key="invite-details-dialog"
            ref={dialogRef}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-1/2 z-[51] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-details-title"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Building2 className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
                <h2 id="invite-details-title" className="text-sm font-semibold text-[var(--color-content-primary)]">
                  {status === 'loaded' && details ? details.org_name : 'Invitation details'}
                </h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close invitation details"
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            {status === 'loading' && (
              <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-content-secondary)]">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Loading org details…
              </div>
            )}

            {status === 'error' && (
              <div className="flex items-start gap-2 py-2 text-xs text-[var(--color-content-secondary)]">
                <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                <p>
                  Details aren&apos;t available right now. You can still accept or decline this
                  invitation below.
                </p>
              </div>
            )}

            {status === 'loaded' && details && (
              <dl className="mb-4 flex flex-col gap-2 text-xs text-[var(--color-content-secondary)]">
                <div className="flex items-center justify-between gap-2">
                  <dt>Organization</dt>
                  <dd className="font-medium text-[var(--color-content-primary)]">{details.org_slug}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt>Created</dt>
                  <dd>{formatOrgCreatedAt(details.org_created_at)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt>Members</dt>
                  <dd>{memberCountLabel(details.member_count)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt>Role offered</dt>
                  <dd className="font-medium text-[var(--color-content-primary)]">{ROLE_LABEL[invite.role]}</dd>
                </div>
                {details.inviter_handle && (
                  <div className="flex items-center justify-between gap-2">
                    <dt>Invited by</dt>
                    <dd className="flex items-center gap-1.5">
                      {avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={avatarUrl} alt="" className="size-4 rounded-full" />
                      )}
                      <span className="font-medium text-[var(--color-content-primary)]">
                        @{details.inviter_handle}
                      </span>
                    </dd>
                  </div>
                )}
                {expiryLabel && (
                  <div className="flex items-center justify-between gap-2">
                    <dt>Expiry</dt>
                    <dd>{expiryLabel}</dd>
                  </div>
                )}
              </dl>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onDecline(invite)}
                disabled={pending}
                className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => onAccept(invite)}
                disabled={pending}
                className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
              >
                Accept
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
