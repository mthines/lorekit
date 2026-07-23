'use client';

/**
 * Attaches the authenticated user's opaque ID to all subsequent RUM telemetry.
 * Rendered inside the dashboard layout — runs once per session after login.
 * Per otel-semantic-conventions: user.id must be opaque (UUID), never email/name.
 */
import { useEffect } from 'react';
import { identifyUser } from '@/instrumentation-client';

interface RumIdentityProps {
  userId: string;
}

export function RumIdentity({ userId }: RumIdentityProps) {
  useEffect(() => {
    identifyUser(userId);
  }, [userId]);

  return null;
}
