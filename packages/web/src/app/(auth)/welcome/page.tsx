import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/AuthCard';
import { WelcomeContent } from '@/components/auth/WelcomeContent';

export const metadata: Metadata = {
  title: 'Welcome to LoreKit',
  description: 'Your LoreKit account is ready.',
  robots: { index: false, follow: false },
};

export default function WelcomePage() {
  return (
    <AuthCard
      title="Welcome to LoreKit"
      description="Your account has been created. Your agents can start writing lore as soon as you're in."
    >
      {/* WelcomeContent reads ?error= via useSearchParams. */}
      <Suspense
        fallback={
          <p role="status" className="text-sm text-[var(--color-content-secondary)]">
            Finishing up...
          </p>
        }
      >
        <WelcomeContent />
      </Suspense>
    </AuthCard>
  );
}
