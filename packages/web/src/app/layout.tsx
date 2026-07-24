import type { Metadata, Viewport } from 'next';
import { ReactQueryProvider } from '@/components/providers/ReactQueryProvider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s — LoreKit',
    default: 'LoreKit',
  },
  description: 'Shared, persistent memory for AI coding agents.',
  metadataBase: new URL(process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3001'),
  openGraph: {
    siteName: 'LoreKit',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0d0e11',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        {/*
         * Dash0Provider is intentionally NOT mounted here.
         * The dashboard layout mounts it with the authenticated userId so RUM
         * telemetry is correctly attributed. The login page has no user to
         * identify, so mounting an unauthenticated instance here would create
         * a duplicate initialisation on every dashboard page load.
         */}
        <ReactQueryProvider>{children}</ReactQueryProvider>
      </body>
    </html>
  );
}
