'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  MARKABLE_STEP_IDS,
  ONBOARDING_DISMISSED_KEY,
  ONBOARDING_DONE_KEY,
  ONBOARDING_STEP_IDS,
  ONBOARDING_TOTAL,
  serverDoneFor,
  type OnboardingServerState,
  type OnboardingStepId,
} from '@/lib/onboarding';

interface OnboardingContextValue {
  /** Effective completion — server signal OR a manual "mark as done". */
  isDone: (id: string) => boolean;
  /** True only when completion comes from a manual toggle (so it can be undone). */
  isManuallyDone: (id: string) => boolean;
  /** Whether this step can be marked complete by hand. */
  isMarkable: (id: string) => boolean;
  toggleDone: (id: string) => void;
  completedCount: number;
  total: number;
  allDone: boolean;
  /** Overview-only: hide the inline checklist (the sidebar stays the way back). */
  dismissed: boolean;
  dismiss: () => void;
  restore: () => void;
  /** False until localStorage has been read, so SSR and first paint agree. */
  hydrated: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({
  serverState,
  children,
}: {
  serverState: OnboardingServerState;
  children: React.ReactNode;
}) {
  const [manualDone, setManualDone] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Read persisted state after mount so the server render (empty overrides)
  // matches the first client render, avoiding a hydration mismatch.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ONBOARDING_DONE_KEY);
      if (raw) setManualDone(new Set(JSON.parse(raw) as string[]));
      setDismissed(localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1');
    } catch {
      // Ignore malformed/unavailable storage — fall back to server signals only.
    }
    setHydrated(true);
  }, []);

  const isMarkable = useCallback(
    (id: string) => MARKABLE_STEP_IDS.includes(id as OnboardingStepId),
    [],
  );

  const isManuallyDone = useCallback((id: string) => manualDone.has(id), [manualDone]);

  const isDone = useCallback(
    (id: string) => {
      if (
        (ONBOARDING_STEP_IDS as readonly string[]).includes(id) &&
        serverDoneFor(id as OnboardingStepId, serverState)
      ) {
        return true;
      }
      return manualDone.has(id);
    },
    [manualDone, serverState],
  );

  const toggleDone = useCallback((id: string) => {
    setManualDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(ONBOARDING_DONE_KEY, JSON.stringify([...next]));
      } catch {
        // Best-effort persistence; the in-memory toggle still works this session.
      }
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      /* best-effort */
    }
  }, []);

  const restore = useCallback(() => {
    setDismissed(false);
    try {
      localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    } catch {
      /* best-effort */
    }
  }, []);

  const completedCount = ONBOARDING_STEP_IDS.filter((id) => isDone(id)).length;
  const allDone = completedCount === ONBOARDING_TOTAL;

  return (
    <OnboardingContext.Provider
      value={{
        isDone,
        isManuallyDone,
        isMarkable,
        toggleDone,
        completedCount,
        total: ONBOARDING_TOTAL,
        allDone,
        dismissed,
        dismiss,
        restore,
        hydrated,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within an OnboardingProvider');
  return ctx;
}
