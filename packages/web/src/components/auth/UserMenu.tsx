'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { LogOut, Trash2, ChevronUp } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface UserMenuProps {
  user: User;
}

/**
 * User avatar button in the sidebar footer.
 *
 * Clicking opens a small popover menu above the avatar with:
 * - Sign out
 * - Delete account (with an inline confirmation step)
 *
 * The delete-account action calls the /api/user/delete route which uses a
 * Supabase service-role client to erase all user data and then calls
 * supabase.auth.admin.deleteUser(). After deletion the session is cleared and
 * the user is redirected to /login.
 */
export function UserMenu({ user }: UserMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signOutLoading, setSignOutLoading] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteError, setDeleteError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape key
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDeleteStep('idle');
        setDeleteError('');
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setDeleteStep('idle');
        setDeleteError('');
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

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
      // Sign out locally and redirect
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push('/login');
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Something went wrong');
      setDeleteStep('confirm');
    }
  }

  const displayName = (user.user_metadata?.['full_name'] as string) ?? user.email ?? 'User';
  const avatarUrl = user.user_metadata?.['avatar_url'] as string | undefined;

  return (
    <div className="relative" ref={menuRef}>
      {/* Popover menu — rendered above the avatar */}
      {open && (
        <div
          role="menu"
          aria-label="User menu"
          className="absolute bottom-full left-0 right-0 mb-1.5 flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg"
        >
          {deleteStep === 'idle' && (
            <>
              {/* Sign out */}
              <button
                role="menuitem"
                onClick={handleSignOut}
                disabled={signOutLoading}
                className="flex min-h-10 w-full items-center gap-2.5 px-3.5 text-left text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-content-primary)] disabled:opacity-50"
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden />
                {signOutLoading ? 'Signing out...' : 'Sign out'}
              </button>

              {/* Separator */}
              <div className="mx-2 my-0.5 h-px bg-[var(--color-border)]" role="separator" />

              {/* Delete account — first click enters confirm step */}
              <button
                role="menuitem"
                onClick={handleDeleteAccount}
                className="flex min-h-10 w-full items-center gap-2.5 px-3.5 text-left text-sm text-red-400 transition-colors duration-150 hover:bg-red-950/30 hover:text-red-300"
              >
                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                Delete account
              </button>
            </>
          )}

          {(deleteStep === 'confirm' || deleteStep === 'deleting') && (
            <div className="flex flex-col gap-2 p-3">
              <p className="text-xs font-medium text-[var(--color-content-primary)]">
                Delete your account?
              </p>
              <p className="text-xs text-[var(--color-content-secondary)]">
                All your lore, tokens, and data will be permanently erased. This cannot be undone.
              </p>
              {deleteError && (
                <p role="alert" className="text-xs text-red-400">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => { setDeleteStep('idle'); setDeleteError(''); }}
                  disabled={deleteStep === 'deleting'}
                  className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-content-secondary)] transition-colors hover:bg-[var(--color-bg-raised)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteStep === 'deleting'}
                  aria-busy={deleteStep === 'deleting'}
                  className="flex-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deleteStep === 'deleting' ? 'Deleting...' : 'Yes, delete'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Avatar trigger button */}
      <button
        ref={buttonRef}
        onClick={() => {
          setOpen((v) => !v);
          if (open) {
            setDeleteStep('idle');
            setDeleteError('');
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`User menu for ${displayName}`}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
      >
        {/* Avatar */}
        <div className="size-5 shrink-0 overflow-hidden rounded-full bg-[var(--color-border)]">
          {avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              aria-hidden
              className="size-full object-cover"
            />
          )}
        </div>
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
        <ChevronUp
          className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? '' : 'rotate-180'}`}
          aria-hidden
        />
      </button>
    </div>
  );
}