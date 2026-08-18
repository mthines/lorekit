/**
 * otel-deployment-env — pure resolution tests (node environment, no DOM/React).
 *
 * The first test is the reproduction for the production incident this module
 * was extracted to fix: a local `next dev` server whose `.env.local` carried a
 * pulled `VERCEL_ENV=production` stamped every span
 * `deployment.environment.name=production`, and its Turbopack dev-server
 * `ENOENT ... app-build-manifest.json` failures tripped the production
 * "Web — high backend error rate" check rule.
 */
import { describe, expect, it } from 'vitest';

import {
  deploymentEnvironmentClampMessage,
  resolveDeploymentEnvironment,
} from './otel-deployment-env';

describe('resolveDeploymentEnvironment', () => {
  it('clamps a pulled VERCEL_ENV=production on a dev server to local', () => {
    // The incident: `vercel env pull` wrote VERCEL_ENV=production into
    // .env.local, and `next dev` (NODE_ENV=development) loaded it.
    const resolution = resolveDeploymentEnvironment('production', 'development');

    expect(resolution.name).toBe('local');
    expect(resolution.clamped).toBe('production');
  });

  it('clamps a pulled VERCEL_ENV=preview on a dev server to local', () => {
    const resolution = resolveDeploymentEnvironment('preview', 'development');

    expect(resolution.name).toBe('local');
    expect(resolution.clamped).toBe('preview');
  });

  it.each([
    ['production', 'production'],
    ['preview', 'preview'],
    ['development', 'development'],
  ] as const)(
    'passes VERCEL_ENV=%s through untouched on a real deployment (NODE_ENV=production)',
    (input, expected) => {
      const resolution = resolveDeploymentEnvironment(input, 'production');

      expect(resolution.name).toBe(expected);
      expect(resolution.clamped).toBeNull();
    },
  );

  it('reports `vercel dev` as development, not local — it is a real Vercel env', () => {
    const resolution = resolveDeploymentEnvironment('development', 'development');

    expect(resolution.name).toBe('development');
    expect(resolution.clamped).toBeNull();
  });

  it.each([undefined, null, '', 'staging'])(
    'falls back to local for %p rather than passing it through',
    (input) => {
      expect(resolveDeploymentEnvironment(input, 'production').name).toBe('local');
      expect(resolveDeploymentEnvironment(input, 'development').name).toBe('local');
    },
  );

  it('does not flag a clamp when nothing was claimed', () => {
    expect(resolveDeploymentEnvironment(undefined, 'development').clamped).toBeNull();
    expect(resolveDeploymentEnvironment('staging', 'development').clamped).toBeNull();
  });

  it('treats an absent NODE_ENV as a dev server — fail safe, never production', () => {
    expect(resolveDeploymentEnvironment('production', undefined).name).toBe('local');
  });
});

describe('deploymentEnvironmentClampMessage', () => {
  it('names both the claimed and the reported environment', () => {
    const message = deploymentEnvironmentClampMessage(
      resolveDeploymentEnvironment('production', 'development'),
    );

    expect(message).toContain('"production"');
    expect(message).toContain('"local"');
    expect(message).toContain('vercel env pull');
  });
});
