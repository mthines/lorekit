'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { LogOut, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { isDeveloperEmail } from '@/lib/developer-users';
import { registerClick } from '@/lib/click-gesture';
import { toggleDeveloperNavRevealed } from '@/lib/hooks/useDeveloperNavRevealed';
import { Button } from '@/components/ui/Button';

/**
 * 5 consecutive clicks (within 2s of each other) toggles the developer nav's
 * visibility in production for an allowlisted developer — see
 * `SettingsNav.tsx` and `lib/click-gesture.ts` for the counting rule and
 * `docs/feature-flags.md` § "Session overrides" for the surrounding design.
 * No visual affordance is added to the avatar for this — it's a secret
 * gesture, not a discoverable control, and it does nothing at all for
 * anyone whose email isn't in `DEVELOPER_EMAILS`.
 */
const REVEAL_CLICK_THRESHOLD = 5;
const REVEAL_CLICK_WINDOW_MS = 2000;

interface UserSettingsPanelProps {
  user: User;
}

/**
 * Client component rendered inside the /settings/user SectionPanel.
 * Shows the signed-in user's avatar, name, and email, then surfaces
 * Sign out and Delete account as explicit actions.
 */
export function UserSettingsPanel({ user }: UserSettingsPanelProps) {
  const router = useRouter();
  const [signOutLoading, setSignOutLoading] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteError, setDeleteError] = useState('');

  const displayName = (user.user_metadata?.['full_name'] as string) ?? user.email ?? 'User';
  const avatarUrl = user.user_metadata?.['avatar_url'] as string | undefined;
  const email = user.email;

  // Click-run state for the developer-nav reveal gesture. Refs, not state —
  // every click is a side effect (maybe toggling the nav), never something
  // that should trigger a re-render of THIS component by itself.
  const lastClickAtRef = useRef<number | null>(null);
  const runLengthRef = useRef(0);
  const isDeveloper = isDeveloperEmail(email);

  const handleAvatarClick = useCallback(() => {
    if (!isDeveloper) return; // does nothing at all for anyone else — see the module doc comment.
    const now = Date.now();
    const result = registerClick(
      lastClickAtRef.current,
      runLengthRef.current,
      now,
      REVEAL_CLICK_WINDOW_MS,
      REVEAL_CLICK_THRESHOLD,
    );
    lastClickAtRef.current = now;
    runLengthRef.current = result.triggered ? 0 : result.runLength;
    if (result.triggered) toggleDeveloperNavRevealed();
  }, [isDeveloper]);

  async function handleSignOut() {
    setSignOutLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  async function handleDeleteAccount() {
    if (deleteStep === 'idle') {
      setDeleteStep('confirm');
      return;
    }
    setDeleteStep('deleting');
    setDeleteError('');
    try {
      const res = await fetch('/api/user/delete', { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to delete account');
      }
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push('/login');
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Something went wrong');
      setDeleteStep('confirm');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Identity ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/*
          A plain button, reset to look identical to the static div it
          replaces — no hover state, no pointer cursor, no visible hint that
          it does anything. It only ever does something for an allowlisted
          developer (`handleAvatarClick` no-ops otherwise), so there is
          nothing to advertise to anyone else.
        */}
        <button
          type="button"
          onClick={handleAvatarClick}
          aria-label="Your avatar"
          className="size-14 shrink-0 cursor-default overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0 appearance-none"
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" aria-hidden className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-xl font-bold text-[var(--color-content-tertiary)]">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--color-content-primary)]">{displayName}</p>
          {email && (
            <p className="truncate text-xs text-[var(--color-content-secondary)]">{email}</p>
          )}
        </div>
      </div>

      {/* ── Divider ────────────────────────────────────────────────────── */}
      <div className="h-px bg-[var(--color-border)]" />

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        {/* Sign out */}
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          leftIcon={<LogOut className="size-4 shrink-0" />}
          disabled={signOutLoading}
          onClick={handleSignOut}
        >
          {signOutLoading ? 'Signing out...' : 'Sign out'}
        </Button>

        {/* Delete account */}
        {deleteStep === 'idle' && (
          <Button
            variant="danger-outline"
            size="lg"
            fullWidth
            leftIcon={<Trash2 className="size-4 shrink-0" />}
            onClick={handleDeleteAccount}
          >
            Delete account
          </Button>
        )}

        {(deleteStep === 'confirm' || deleteStep === 'deleting') && (
          <div className="flex flex-col gap-3 rounded-lg border border-red-800/40 bg-red-950/20 p-4">
            <p className="text-sm font-medium text-[var(--color-content-primary)]">
              Delete your account?
            </p>
            <p className="text-xs text-[var(--color-content-secondary)]">
              All your lore, tokens, webhook secrets, and audit logs will be permanently erased.
              This cannot be undone.
            </p>
            {deleteError && (
              <p role="alert" className="text-xs text-red-400">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                disabled={deleteStep === 'deleting'}
                onClick={() => { setDeleteStep('idle'); setDeleteError(''); }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                disabled={deleteStep === 'deleting'}
                aria-busy={deleteStep === 'deleting'}
                onClick={handleDeleteAccount}
              >
                {deleteStep === 'deleting' ? 'Deleting...' : 'Yes, delete everything'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}