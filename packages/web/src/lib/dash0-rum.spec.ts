import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The real SDK never runs in a unit test, but the ATTRIBUTE SEMANTICS do: this
// stand-in mirrors the Dash0 web SDK (`sdk-web`) 0.23.0 exactly — `addSignalAttribute`
// APPENDS, `removeSignalAttribute` splices the first match, and `identify`
// removes any existing `user.id` before adding one. That append-vs-replace
// distinction is the whole point of the identity specs below, so a stubbed
// `vi.fn()` would assert nothing about it.
vi.mock('@dash0/sdk-web', () => {
  const signalAttributes: Array<{ key: string; value: unknown }> = [];
  const remove = (key: string) => {
    const index = signalAttributes.findIndex((attr) => attr.key === key);
    if (index !== -1) signalAttributes.splice(index, 1);
  };
  return {
    init: () => undefined,
    addSignalAttribute: (key: string, value: unknown) => {
      signalAttributes.push({ key, value });
    },
    removeSignalAttribute: remove,
    identify: (id?: string) => {
      remove('user.id');
      if (id != null) signalAttributes.push({ key: 'user.id', value: id });
    },
    __signalAttributes: signalAttributes,
  };
});

const {
  isValidOtlpEndpoint,
  resolveDeploymentEnv,
  buildVcsSignalAttributes,
  initDash0Rum,
  identifyDash0User,
  setDash0PagePath,
} = await import('./dash0-rum');

const { __signalAttributes: signalAttributes } = (await import('@dash0/sdk-web')) as unknown as {
  __signalAttributes: Array<{ key: string; value: unknown }>;
};

const ORIGINAL_ENV = { ...process.env };

// `initDash0Rum` is guarded to run once per module instance, so the state it
// leaves behind is captured here and each identity spec restores it.
process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'] = 'https://ingress.example.com';
process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'] = 'auth-token';
const INITIALISED = initDash0Rum();
const AFTER_INIT = [...signalAttributes];

const valuesOf = (key: string) =>
  signalAttributes.filter((attr) => attr.key === key).map((attr) => attr.value);

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

describe('signal identity and route attributes', () => {
  beforeEach(() => {
    signalAttributes.splice(0, signalAttributes.length, ...AFTER_INIT);
  });

  it('initialises once and identifies the visitor anonymously', () => {
    expect(INITIALISED).toBe(true);
    expect(initDash0Rum()).toBe(false);
  });

  it('carries exactly one user.id after init — identify() must not be paired with an append', () => {
    expect(valuesOf('user.id')).toHaveLength(1);
    expect(String(valuesOf('user.id')[0])).toMatch(/^anon:/);
  });

  it('REPLACES the anonymous id on login instead of leaving a second user.id behind', () => {
    identifyDash0User('user-abc');
    expect(valuesOf('user.id')).toEqual(['user-abc']);
  });

  it('keeps a single page.url.path across repeated navigations', () => {
    setDash0PagePath('/lore');
    setDash0PagePath('/settings');
    setDash0PagePath('/settings'); // the second Dash0Provider mount
    expect(valuesOf('page.url.path')).toEqual(['/settings']);
  });
});
