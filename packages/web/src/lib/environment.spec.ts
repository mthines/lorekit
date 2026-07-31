import { describe, it, expect } from 'vitest';
import { resolveEnvironmentBadge } from './environment';

describe('resolveEnvironmentBadge', () => {
  it('renders nothing for a production frontend on a production backend', () => {
    expect(
      resolveEnvironmentBadge({
        backendEnv: 'production',
        vercelEnv: 'production',
        projectRef: 'prodprojectref00',
      }),
    ).toBeNull();
  });

  it('renders nothing for a production frontend with no backend tag', () => {
    expect(resolveEnvironmentBadge({ vercelEnv: 'production' })).toBeNull();
  });

  it('flags the preview backend, which is what /preview deploys build against', () => {
    const badge = resolveEnvironmentBadge({
      backendEnv: 'preview',
      vercelEnv: 'preview',
      projectRef: 'previewref123456',
    });
    expect(badge).not.toBeNull();
    expect(badge?.label).toBe('PREVIEW BACKEND');
    expect(badge?.detail).toBe('supabase · previewref123456');
    expect(badge?.tone).toBe('preview');
  });

  // The case the badge exists for: a bundle that looks like production but was
  // built against a non-production database.
  it('flags a non-production backend even when the frontend is production', () => {
    const badge = resolveEnvironmentBadge({
      backendEnv: 'staging',
      vercelEnv: 'production',
      projectRef: 'stagingref123456',
    });
    expect(badge?.label).toBe('STAGING BACKEND');
    expect(badge?.tone).toBe('preview');
  });

  // A push-triggered Vercel preview is a routine part of every PR and talks to
  // whatever backend the Vercel project is configured with. Marking it would
  // make the badge ambient noise, so VERCEL_ENV alone must never trigger it —
  // only an explicitly tagged backend does.
  it('renders nothing for an untagged Vercel preview', () => {
    expect(
      resolveEnvironmentBadge({ vercelEnv: 'preview', projectRef: 'someref12345678' }),
    ).toBeNull();
  });

  it('renders nothing for an untagged Vercel preview even with no project ref', () => {
    expect(resolveEnvironmentBadge({ vercelEnv: 'preview' })).toBeNull();
  });

  it('still marks a /preview deploy, which tags the backend on top of VERCEL_ENV=preview', () => {
    const badge = resolveEnvironmentBadge({ backendEnv: 'preview', vercelEnv: 'preview' });
    expect(badge?.label).toBe('PREVIEW BACKEND');
  });

  it('labels local builds, where neither env var is set', () => {
    const badge = resolveEnvironmentBadge({});
    expect(badge?.label).toBe('LOCAL');
    expect(badge?.tone).toBe('local');
  });

  it('labels a `vercel dev` build, which reports VERCEL_ENV=development', () => {
    const badge = resolveEnvironmentBadge({ vercelEnv: 'development' });
    expect(badge?.label).toBe('LOCAL');
    expect(badge?.tone).toBe('local');
  });

  it('omits the detail line when no project ref is baked in', () => {
    expect(resolveEnvironmentBadge({ backendEnv: 'preview' })?.detail).toBeNull();
  });

  it('is tolerant of casing and whitespace in the env vars', () => {
    const badge = resolveEnvironmentBadge({
      backendEnv: '  Preview ',
      vercelEnv: ' PREVIEW ',
      projectRef: ' previewref123456 ',
    });
    expect(badge?.label).toBe('PREVIEW BACKEND');
    expect(badge?.detail).toBe('supabase · previewref123456');
  });
});
