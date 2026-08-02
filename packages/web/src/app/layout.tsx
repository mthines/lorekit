import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { ReactQueryProvider } from '@/components/providers/ReactQueryProvider';
import { Dash0Provider } from '@/components/providers/Dash0Provider';
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
         * Mounted at the ROOT so public pages — marketing, /docs, /login — are
         * instrumented too. They previously emitted RUM with no route tracking
         * and no identity at all, which is why 29 of 36 sessions were
         * indistinguishable anonymous traffic.
         *
         * No userId here: an unauthenticated visitor keeps the anonymous id
         * assigned at init. The dashboard layout mounts a second instance WITH
         * the authenticated userId, which upgrades the identity. Mounting twice
         * is safe — initialisation is guarded in lib/dash0-rum.ts (a single
         * module-level flag, unlike the two per-module copies this replaced).
         */}
        <Dash0Provider />
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
