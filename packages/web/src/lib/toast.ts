/**
 * Reusable toast helper — a thin wrapper around sonner's `toast()` so every
 * call site shares one small variant vocabulary instead of reaching for
 * `toast.success`/`toast.error`/`toast.info` directly. Mirrors the retired
 * `useToast().showToast(message, variant)` API (the old aria-live
 * `ToastProvider`) so call sites only had to swap their import — sonner's own
 * `<Toaster>` (mounted once in the dashboard layout) renders and announces
 * every toast, aria-live included, so no provider is needed here.
 */

import { toast } from 'sonner';

export type ToastVariant = 'success' | 'error' | 'info';

export function showToast(message: string, variant: ToastVariant = 'success'): void {
  switch (variant) {
    case 'success':
      toast.success(message);
      return;
    case 'error':
      toast.error(message);
      return;
    case 'info':
      toast.info(message);
      return;
  }
}

// Re-exported so call sites that want sonner's richer API (descriptions,
// actions, promises, manual dismissal) can `import { toast } from '@/lib/toast'`
// instead of reaching past this module back to 'sonner' directly.
export { toast };
