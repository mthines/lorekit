'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useRef } from 'react';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  // One client per browser session — useRef avoids the module-level singleton
  // anti-pattern so server rendering never leaks state between requests.
  const clientRef = useRef<QueryClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = new QueryClient({
      defaultOptions: {
        queries: {
          // Data is considered fresh for 60 s — no background refetch within that window.
          staleTime: 60_000,
          // Keep unused query data in memory for 5 min so navigating back feels instant.
          gcTime: 5 * 60_000,
          // Retry once on transient Supabase errors before surfacing to the UI.
          retry: 1,
          // Refetch on tab focus so dashboards that have been open overnight stay current.
          refetchOnWindowFocus: true,
        },
      },
    });
  }

  return (
    <QueryClientProvider client={clientRef.current}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
