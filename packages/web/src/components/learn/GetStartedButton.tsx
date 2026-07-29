'use client';

import { useState } from 'react';
import { GettingStartedDialog } from '@/components/learn/GettingStartedDialog';

/**
 * Thin client wrapper that owns the open/close state for the getting-started
 * dialog. Kept separate so the login page stays a server component (preserving
 * the metadata export and static render).
 */
export function GetStartedButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex justify-center border-t border-[var(--color-border)] pt-5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          View full setup guide
          <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="size-3.5">
            <path fillRule="evenodd" d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      <GettingStartedDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
