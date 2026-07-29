import type { Metadata } from 'next';
import { TutorialCard } from '@/components/learn/TutorialCard';
import { GettingStartedContent } from '@/components/learn/GettingStartedContent';

export const metadata: Metadata = { title: 'Getting started' };

/**
 * Getting started — the first page new users land on.
 *
 * Content lives in GettingStartedContent (shared with the login page dialog)
 * so there is one source of truth for the three-step setup flow. The
 * TutorialCard chrome stays here as a dashboard-specific layout wrapper.
 *
 * API keys and webhook secrets live in Settings — we link there rather than
 * embedding the token manager inline, keeping the tutorial scannable and
 * avoiding a token-generation side-effect on every page view.
 */
export default function LearnSetupPage() {
  return (
    <TutorialCard>
      <GettingStartedContent />
    </TutorialCard>
  );
}
