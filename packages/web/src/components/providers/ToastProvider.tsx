'use client';

/**
 * ToastProvider — an aria-live toast context (`role="status"`, `aria-live`
 * "polite") mounted once at the dashboard root. Any client component calls
 * `useToast().showToast(message, variant)`; the toast is announced to screen
 * readers and auto-dismisses after a few seconds. Passive, not a modal
 * interrupt (ux-design core-principles) — matches the org invite
 * accept/decline and destructive-action feedback flows (plan.md Decision D7).
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastEntry {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within <ToastProvider>');
  }
  return ctx;
}

const VARIANT_META: Record<ToastVariant, { icon: typeof CheckCircle2; style: string }> = {
  success: { icon: CheckCircle2, style: 'border-[var(--color-success)]/40 text-[var(--color-success)]' },
  error: { icon: XCircle, style: 'border-[var(--color-error)]/40 text-[var(--color-error)]' },
  info: { icon: Info, style: 'border-[var(--color-info)]/40 text-[var(--color-info)]' },
};

const AUTO_DISMISS_MS = 4500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reduceMotion = useReducedMotion();

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = 'success') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { id, message, variant }]);
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const contextValue = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* aria-live region: screen readers announce each toast as it appears.
          role="status" is polite — matches the non-interruptive nature of a
          success/info confirmation. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        <AnimatePresence>
          {toasts.map((toast) => {
            const { icon: Icon, style } = VARIANT_META[toast.variant];
            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className={[
                  'pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border bg-[var(--color-bg-raised)] px-4 py-2.5 text-sm shadow-2xl',
                  style,
                ].join(' ')}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="text-[var(--color-content-primary)]">{toast.message}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
