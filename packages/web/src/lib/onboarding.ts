import type { ReactNode } from 'react';

/**
 * Shared, dependency-free onboarding model.
 *
 * This module is intentionally free of any server-only imports (no Supabase
 * client, no server actions) so it can be imported from both React Server
 * Components and client components — the {@link OnboardingProvider} and the
 * server-side step builder rely on the same canonical step list and
 * completion rules.
 */

export const ONBOARDING_STEP_IDS = ['server', 'connect', 'webhook'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const ONBOARDING_TOTAL = ONBOARDING_STEP_IDS.length;

/**
 * Steps a user can mark complete by hand.
 *
 * The webhook step has no reliable server signal until a delivery actually
 * fires — a user can finish the GitHub setup long before the first PR review
 * comment arrives — so we let them self-attest that they're done. The other
 * steps complete from an unambiguous server signal and need no manual toggle.
 */
export const MARKABLE_STEP_IDS: readonly OnboardingStepId[] = ['webhook'];

export interface OnboardingServerState {
  /** At least one memory exists → an agent has connected and written a lesson. */
  hasLessons: boolean;
  /** At least one memory tagged `source::pr-webhook` exists → a webhook fired. */
  hasWebhook: boolean;
}

/**
 * Whether a step is complete from the server's perspective, ignoring any
 * client-side manual override. The `server` step is always complete — the
 * Edge Function is deployed the moment the account exists.
 */
export function serverDoneFor(id: OnboardingStepId, state: OnboardingServerState): boolean {
  switch (id) {
    case 'server':
      return true;
    case 'connect':
      return state.hasLessons;
    case 'webhook':
      return state.hasWebhook;
  }
}

/** A single onboarding step. Completion is derived from the provider, not stored here. */
export interface OnboardingStep {
  id: OnboardingStepId | string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  content: ReactNode;
}

// localStorage keys — shared so the provider is the single source of truth.
export const ONBOARDING_DISMISSED_KEY = 'lorekit:onboarding-dismissed';
export const ONBOARDING_DONE_KEY = 'lorekit:onboarding-done';
