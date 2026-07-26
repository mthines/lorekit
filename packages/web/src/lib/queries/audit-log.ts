'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { listAuditLog, type AuditLogPage } from '@/lib/audit-log';
import type { AuditAction } from '@/lib/audit-actions';
import type { DateRange } from '@/components/ui/DateRangePicker';

export interface UseAuditLogFilters {
  actions: AuditAction[];
  name: string;
  range: DateRange | null;
}

/**
 * `useInfiniteQuery` over the `listAuditLog` server action, keyed by the
 * current filter state. Changing any filter changes the query key, which
 * resets pagination for free — no manual "reset cursor on filter change"
 * bookkeeping needed. `fetchNextPage` drives the "Load more" control.
 */
export function useAuditLog(filters: UseAuditLogFilters) {
  return useInfiniteQuery<AuditLogPage>({
    queryKey: ['audit-log', filters.actions, filters.name, filters.range],
    queryFn: ({ pageParam }) =>
      listAuditLog({
        actions: filters.actions,
        name: filters.name,
        range: filters.range,
        cursor: pageParam as string | null,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    // Audit events are relatively low-frequency and security-sensitive to get
    // right rather than instantly fresh — 30s matches the Settings-area
    // staleness tolerance (same cadence as the Activity feed).
    staleTime: 30_000,
  });
}
