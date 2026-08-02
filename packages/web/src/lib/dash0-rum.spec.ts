import { describe, it, expect, vi, afterEach } from 'vitest';

// The SDK is never really initialised in a unit test — these specs cover the
// pure decision helpers, which are the parts that had drifted between the two
// former copies. `initDash0Rum` itself is an impure shell over `init()` and is
// exercised by running the app.
vi.mock('@dash0/sdk-web', () => ({
  init: vi.fn(),
  addSignalAttribute: vi.fn(),
  identify: vi.fn(),
}));

const { isValidOtlpEndpoint, resolveDeploymentEnv, buildVcsSignalAttributes } = await import('./dash0-rum');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('isValidOtlpEndpoint', () => {
  it('accepts an absolute https endpoint on another origin', () => {
    expect(isValidOtlpEndpoint('https://ingress.example.com', 'https://lorekit.io')).toBe(true);
  });

  it('accepts http for local development', () => {
    expect(isValidOtlpEndpoint('http://localhost:4318', 'http://localhost:3000')).toBe(true);
  });

  it('rejects undefined and empty', () => {
    expect(isValidOtlpEndpoint(undefined, 'https://lorekit.io')).toBe(false);
    expect(isValidOtlpEndpoint('', 'https://lorekit.io')).toBe(false);
  });

  it('rejects a relative path — the misconfiguration this guard exists for', () => {
    expect(isValidOtlpEndpoint('/', 'https://lorekit.io')).toBe(false);
    expect(isValidOtlpEndpoint('/v1/traces', 'https://lorekit.io')).toBe(false);
  });

  it('rejects a non-http protocol', () => {
    expect(isValidOtlpEndpoint('ftp://ingress.example.com', 'https://lorekit.io')).toBe(false);
  });

  it('rejects the app origin itself and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(isValidOtlpEndpoint('https://lorekit.io/ingest', 'https://lorekit.io')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('accepts a same-host endpoint on a different port (a different origin)', () => {
    expect(isValidOtlpEndpoint('http://localhost:4318', 'http://localhost:3000')).toBe(true);
  });
});

describe('resolveDeploymentEnv', () => {
  it.each([
    ['production', 'production'],
    ['preview', 'preview'],
    ['development', 'development'],
  ])('maps NEXT_PUBLIC_VERCEL_ENV=%s to %s', (input, expected) => {
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = input;
    expect(resolveDeploymentEnv()).toBe(expected);
  });

  it('falls back to local when unset', () => {
    delete process.env['NEXT_PUBLIC_VERCEL_ENV'];
    expect(resolveDeploymentEnv()).toBe('local');
  });

  it('falls back to local for an unrecognised value rather than passing it through', () => {
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = 'staging';
    expect(resolveDeploymentEnv()).toBe('local');
  });
});

describe('buildVcsSignalAttributes', () => {
  it('is empty when no VCS vars are set — never blank fields', () => {
    for (const key of [
      'NEXT_PUBLIC_VCS_REPO_OWNER',
      'NEXT_PUBLIC_VCS_REPO_SLUG',
      'NEXT_PUBLIC_VCS_REF_HEAD_NAME',
      'NEXT_PUBLIC_VCS_REF_HEAD_REVISION',
    ]) {
      delete process.env[key];
    }

    expect(buildVcsSignalAttributes()).toEqual({});
  });

  it('builds the repo URL and name only when BOTH owner and slug are present', () => {
    process.env['NEXT_PUBLIC_VCS_REPO_OWNER'] = 'mthines';
    delete process.env['NEXT_PUBLIC_VCS_REPO_SLUG'];
    expect(buildVcsSignalAttributes()).toEqual({});

    process.env['NEXT_PUBLIC_VCS_REPO_SLUG'] = 'lorekit';
    expect(buildVcsSignalAttributes()).toEqual({
      'vcs.repository.url.full': 'https://github.com/mthines/lorekit',
      'vcs.repository.name': 'mthines/lorekit',
    });
  });

  it('adds the branch type alongside the branch name', () => {
    process.env['NEXT_PUBLIC_VCS_REF_HEAD_NAME'] = 'feat/rum-identity';
    expect(buildVcsSignalAttributes()).toEqual({
      'vcs.ref.head.name': 'feat/rum-identity',
      'vcs.ref.head.type': 'branch',
    });
  });

  it('adds the revision on its own', () => {
    process.env['NEXT_PUBLIC_VCS_REF_HEAD_REVISION'] = 'abc1234';
    expect(buildVcsSignalAttributes()).toEqual({ 'vcs.ref.head.revision': 'abc1234' });
  });
});
