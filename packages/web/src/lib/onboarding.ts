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

// The one mandatory setup step: connect an agent via MCP.
// The GitHub webhook is an optional enrichment feature, not a gate — it is
// surfaced separately via GithubAppTeaser once the connect step is done.
export const ONBOARDING_STEP_IDS = ['connect'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const ONBOARDING_TOTAL = ONBOARDING_STEP_IDS.length;

/**
 * Steps a user can mark complete by hand.
 *
 * The connect step completes automatically from a server signal (first lesson
 * written) so no manual toggle is needed. Kept as an empty tuple for
 * forward-compatibility.
 */
export const MARKABLE_STEP_IDS: readonly OnboardingStepId[] = [];

export interface OnboardingServerState {
  /** At least one memory exists → an agent has connected and written a lesson. */
  hasLessons: boolean;
  /** At least one memory tagged `source::pr-webhook` exists → a webhook fired. */
  hasWebhook: boolean;
}

/**
 * Whether a step is complete from the server's perspective, ignoring any
 * client-side manual override.
 */
export function serverDoneFor(id: OnboardingStepId, state: OnboardingServerState): boolean {
  switch (id) {
    case 'connect':
      return state.hasLessons;
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
