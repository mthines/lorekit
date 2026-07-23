import type { Metadata, Viewport } from 'next';
import { Dash0Provider } from '@/components/providers/Dash0Provider';
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
        {/* Dash0 Web SDK — initialised here so it covers login page too.
            userId is passed from dashboard layout after auth. */}
        <Dash0Provider />
        {/* ReactQueryProvider wraps everything so all client components below
            can call useQuery / useSuspenseQuery without their own provider. */}
        <ReactQueryProvider>{children}</ReactQueryProvider>
      </body>
    </html>
  );
}
