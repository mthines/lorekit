import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { ReactQueryProvider } from '@/components/providers/ReactQueryProvider';
import { EnvironmentBanner } from '@/components/layout/EnvironmentBanner';
import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s — LoreKit',
    default: 'LoreKit',
  },
  description: 'Shared, persistent memory for AI coding agents.',
  metadataBase: new URL(process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3001'),
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'LoreKit',
  },
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
      <head>
        {/* iOS home-screen icons (until Safari honours the manifest) */}
        <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" sizes="512x512" href="/icons/icon-512.png" />
      </head>
      <body className="min-h-screen antialiased">
        {/*
         * Non-production marker. Renders null on production builds; on a
         * preview/staging build it overlays a stripe + label naming the
         * backend the bundle was built against. Mounted at the root so the
         * auth pages carry it too — a preview build authenticates against the
         * preview Supabase project, which has its own user table.
         */}
        <EnvironmentBanner />

        {/*
         * Dash0Provider is intentionally NOT mounted here.
         * The dashboard layout mounts it with the authenticated userId so RUM
         * telemetry is correctly attributed. The login page has no user to
         * identify, so mounting an unauthenticated instance here would create
         * a duplicate initialisation on every dashboard page load.
         */}
        <ReactQueryProvider>{children}</ReactQueryProvider>

        {/* Register the service worker for PWA offline-shell support */}
        <Script id="sw-register" strategy="afterInteractive">
          {`if ('serviceWorker' in navigator) {
              window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch(() => {});
              });
            }`}
        </Script>
      </body>
    </html>
  );
}
