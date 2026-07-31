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

  it('falls back to the Vercel environment when the backend is untagged', () => {
    const badge = resolveEnvironmentBadge({ vercelEnv: 'preview', projectRef: 'someref12345678' });
    expect(badge?.label).toBe('PREVIEW DEPLOY');
    expect(badge?.description).toContain('not tagged');
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
