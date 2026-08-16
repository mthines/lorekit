import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The real SDK never runs in a unit test, but the ATTRIBUTE SEMANTICS do: this
// stand-in mirrors the Dash0 web SDK (`sdk-web`) 0.23.0 exactly —
// `addSignalAttribute` APPENDS, `removeSignalAttribute` splices the first
// match, and `identify` removes any existing `user.id` before adding one. That
// append-vs-replace distinction is the whole point of the identity specs below,
// so a stubbed `vi.fn()` would assert nothing about it. The append-only pair is
// kept in the stand-in even though the module no longer calls it, so a spec can
// still catch a regression that reintroduces an appended attribute.
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
  resetDash0Identity,
  installExtensionErrorFilter,
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
    expect(isValidOtlpEndpoint('https://lorekit.io:4318', 'https://lorekit.io')).toBe(true);
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

describe('signal identity attributes', () => {
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

  // That the anonymous id is the SAME one across calls is `resolveAnonymousId`'s
  // property and is proven in `anonymous-id.spec.ts` ("is stable across calls").
  // This env has no `localStorage`, so what is asserted here is the part that
  // belongs to this module: the signed-out `user.id` is gone, replaced by an
  // anonymous one, and there is still exactly one of them.
  it('drops the authenticated user.id for an anonymous one on sign-out', () => {
    identifyDash0User('user-abc');
    expect(valuesOf('user.id')).toEqual(['user-abc']);

    resetDash0Identity();

    expect(valuesOf('user.id')).toHaveLength(1);
    expect(String(valuesOf('user.id')[0])).toMatch(/^anon:/);
  });

  it('never writes its own page.url.path — the SDK derives one per signal', () => {
    expect(valuesOf('page.url.path')).toEqual([]);
  });
});

/**
 * The filter's job is to stop an extension's error before the SDK's own
 * listener sees it, so what is asserted here is exactly that: a second listener
 * — standing in for `@dash0/sdk-web`'s, registered after ours the way `init()`
 * registers it after `installExtensionErrorFilter()` — must not run for an
 * extension error, and must still run for one of ours.
 *
 * Origin classification itself lives in `extension-errors.spec.ts`; these specs
 * only prove the wiring.
 */
describe('installExtensionErrorFilter', () => {
  const EXTENSION_STACK = [
    "TypeError: Cannot read properties of undefined (reading 'M_ID')",
    '    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)',
  ].join('\n');

  const FIRST_PARTY_STACK = [
    'TypeError: cannot read scope of null',
    '    at LoreList (https://www.lorekit.io/_next/static/chunks/page.js:1:761)',
  ].join('\n');

  /** Subscribe a stand-in for the SDK, AFTER the filter, as `init()` does. */
  const attachSdkListener = (target: EventTarget, type: string) => {
    const listener = vi.fn();
    target.addEventListener(type, listener);
    return listener;
  };

  const dispatch = (target: EventTarget, type: string, props: Record<string, unknown>) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, props);
    target.dispatchEvent(event);
  };

  it('hides an extension-only unhandled rejection from the SDK', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkListener(target, 'unhandledrejection');

    dispatch(target, 'unhandledrejection', { reason: { stack: EXTENSION_STACK } });

    expect(sdk).not.toHaveBeenCalled();
    teardown();
  });

  it('lets a first-party unhandled rejection through', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkListener(target, 'unhandledrejection');

    dispatch(target, 'unhandledrejection', { reason: { stack: FIRST_PARTY_STACK } });

    expect(sdk).toHaveBeenCalledOnce();
    teardown();
  });

  it('hides an extension-only uncaught error from the SDK', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkListener(target, 'error');

    dispatch(target, 'error', {
      error: { stack: EXTENSION_STACK },
      filename: 'chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js',
    });

    expect(sdk).not.toHaveBeenCalled();
    teardown();
  });

  it('lets a first-party uncaught error through', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkListener(target, 'error');

    dispatch(target, 'error', {
      error: { stack: FIRST_PARTY_STACK },
      filename: 'https://www.lorekit.io/_next/static/chunks/page.js',
    });

    expect(sdk).toHaveBeenCalledOnce();
    teardown();
  });

  it('keeps an error it cannot attribute — a rejection with no stack at all', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkListener(target, 'unhandledrejection');

    dispatch(target, 'unhandledrejection', { reason: 'boom' });

    expect(sdk).toHaveBeenCalledOnce();
    teardown();
  });

  it('does not cancel the event — the browser still logs it to the console', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);

    const event = new Event('unhandledrejection', { cancelable: true });
    Object.assign(event, { reason: { stack: EXTENSION_STACK } });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    teardown();
  });

  it('stops filtering once torn down', () => {
    const target = new EventTarget();
    const teardown = installExtensionErrorFilter(target);
    teardown();
    const sdk = attachSdkListener(target, 'unhandledrejection');

    dispatch(target, 'unhandledrejection', { reason: { stack: EXTENSION_STACK } });

    expect(sdk).toHaveBeenCalledOnce();
  });

  it('is a no-op outside the browser rather than throwing', () => {
    // `instrumentation-client.ts` is evaluated server-side during static
    // prerendering, where there is no `window` to subscribe on.
    expect(() => installExtensionErrorFilter()()).not.toThrow();
  });
});
