'use client';

/**
 * ExplorerResultsProvider
 *
 * Lets the Lore Explorer report its current view's result count up to the
 * dashboard-wide `TopBar`, so the header's `MemoryExpandButton` can show
 * "12 of 128 memories" while a scope, search term, filter pill, retention
 * condition or date range narrows the Explorer — instead of a bare unscoped
 * total that silently ignores what the reader is looking at. See
 * `lib/explorer-result-count.ts` for the pure decision of what counts as
 * "narrowed" and how the label is built.
 *
 * `results` is `null` on every OTHER page (and on `/lore` itself before the
 * Explorer's first effect runs) — the header falls back to its plain total
 * in that case, exactly as it did before this feature existed. The Explorer
 * clears it back to `null` on unmount so navigating away never leaves a
 * stale filtered count in the header.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface ExplorerResults {
  /**
   * The API's own exact count of every memory the current view matches
   * (`GET /memories`'s `total` field) — never how many rows happen to be
   * loaded into the browser so far.
   */
  matchedCount: number;
  /**
   * True when the current view narrows the account's active memories (a
   * scope, a search term, a filter pill, a retention condition, or a date
   * range) — false on the unfiltered "All scopes" default, and false for the
   * Archived view (see `isExplorerViewFiltered`).
   */
  isFiltered: boolean;
}

interface ExplorerResultsContextValue {
  results: ExplorerResults | null;
  setResults: (results: ExplorerResults | null) => void;
}

const ExplorerResultsContext = createContext<ExplorerResultsContextValue | null>(null);

export function useExplorerResults(): ExplorerResultsContextValue {
  const ctx = useContext(ExplorerResultsContext);
  if (!ctx) {
    throw new Error('useExplorerResults must be used within <ExplorerResultsProvider>');
  }
  return ctx;
}

interface ExplorerResultsProviderProps {
  children: ReactNode;
}

export function ExplorerResultsProvider({ children }: ExplorerResultsProviderProps) {
  const [results, setResults] = useState<ExplorerResults | null>(null);
  const value = useMemo<ExplorerResultsContextValue>(
    () => ({ results, setResults }),
    [results],
  );

  return (
    <ExplorerResultsContext.Provider value={value}>{children}</ExplorerResultsContext.Provider>
  );
}
