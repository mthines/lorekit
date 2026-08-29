import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The real SDK never runs in a unit test, but the ATTRIBUTE SEMANTICS do: this
// stand-in mirrors the Dash0 web SDK (`sdk-web`) 0.23.0 exactly —
// `addSignalAttribute` APPENDS, `removeSignalAttribute` splices the first
// match, and `identify` removes any existing `user.id` before adding one. That
// append-vs-replace distinction is the whole point of the identity specs below,
// so a stubbed `vi.fn()` would assert nothing about it. The append-only pair is
// kept in the stand-in even though the module no longer calls it, so a spec can
// still catch a regression that reintroduces an appended attribute.
// Records what `initDash0Rum` did, in order, across the module boundary — the
// mock factory is hoisted above every other statement, so this is the only way
// it can share state with the specs. `init` is a recording function rather than
// a bare arrow because the ORDER of the filter registration relative to `init()`
// is a correctness property (see `installExtensionErrorFilter`), and a stub that
// records nothing lets that line be deleted with every spec still green.
const boot = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('@dash0/sdk-web', () => {
  const signalAttributes: Array<{ key: string; value: unknown }> = [];
  const remove = (key: string) => {
    const index = signalAttributes.findIndex((attr) => attr.key === key);
    if (index !== -1) signalAttributes.splice(index, 1);
  };
  return {
    init: () => {
      boot.order.push('sdk.init');
    },
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
  resolveDeploymentEnvResolution,
  buildVcsSignalAttributes,
  initDash0Rum,
  identifyDash0User,
  resetDash0Identity,
  installExtensionErrorFilter,
  syncFeatureFlagRumAttributes,
  FEATURE_FLAG_RUM_ATTRIBUTE_PREFIX,
} = await import('./dash0-rum');

const { __signalAttributes: signalAttributes } = (await import('@dash0/sdk-web')) as unknown as {
  __signalAttributes: Array<{ key: string; value: unknown }>;
};

const ORIGINAL_ENV = { ...process.env };

// `initDash0Rum` is guarded to run once per module instance, so the state it
// leaves behind is captured here and each identity spec restores it.
process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'] = 'https://ingress.example.com';
process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'] = 'auth-token';

// These specs run in the `node` environment, where `installExtensionErrorFilter`
// finds no `window` and no-ops — which would make the registration invisible to
// the one-shot boot below. Stand a recording `window` up for the duration of
// that single call, then take it away again so the rest of the file still runs
// server-side, as its own "no-op outside the browser" spec asserts.
const bootWindow = new EventTarget();
const subscribe = bootWindow.addEventListener.bind(bootWindow);
bootWindow.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
  boot.order.push(`listener:${type}`);
  subscribe(type, listener, options as AddEventListenerOptions);
}) as EventTarget['addEventListener'];
// `isValidOtlpEndpoint` reads `window.location.origin` when it is not given one,
// so the stand-in needs an origin or the boot short-circuits before `init()`.
Object.assign(bootWindow, { location: { origin: 'https://www.lorekit.io' } });
(globalThis as { window?: unknown }).window = bootWindow;

const INITIALISED = initDash0Rum();

delete (globalThis as { window?: unknown }).window;
const BOOT_ORDER = [...boot.order];
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

// `resolveDeploymentEnvResolution` is the export the production path uses:
// `initDash0Rum` reads it and warns once when `clamped` is set.
// `resolveDeploymentEnv` is the name-only wrapper over it, so the matrix is
// asserted here and the wrapper is pinned to `.name` by a single case below.
//
// `NODE_ENV` is part of the input — a non-production build is a dev server
// whatever `NEXT_PUBLIC_VERCEL_ENV` claims. Vitest runs with `NODE_ENV=test`,
// so a production build has to be simulated explicitly, or the clamp returns
// `local` for every input and the assertion holds whatever the VERCEL_ENV
// mapping does. `vi.stubEnv` is required: `NODE_ENV` is typed read-only by
// Next's ambient env declarations, so a plain assignment does not typecheck.
describe('resolveDeploymentEnvResolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['production', 'production'],
    ['preview', 'preview'],
    ['development', 'development'],
  ])('maps NEXT_PUBLIC_VERCEL_ENV=%s to %s on a production build', (input, expected) => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = input;
    expect(resolveDeploymentEnvResolution()).toEqual({ name: expected, clamped: null });
  });

  it('falls back to local when unset, on a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env['NEXT_PUBLIC_VERCEL_ENV'];
    expect(resolveDeploymentEnvResolution()).toEqual({ name: 'local', clamped: null });
  });

  it('falls back to local for an unrecognised value rather than passing it through, on a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = 'staging';
    expect(resolveDeploymentEnvResolution()).toEqual({ name: 'local', clamped: null });
  });

  // The incident, through the browser bundle's own env read. `clamped` is what
  // makes `initDash0Rum` warn, so it is asserted, not just the name.
  it.each(['production', 'preview'])(
    'clamps a pulled NEXT_PUBLIC_VERCEL_ENV=%s on a dev build to local, and reports the clamp',
    (input) => {
      vi.stubEnv('NODE_ENV', 'development');
      process.env['NEXT_PUBLIC_VERCEL_ENV'] = input;
      expect(resolveDeploymentEnvResolution()).toEqual({ name: 'local', clamped: input });
    },
  );

  it('reports `vercel dev` as development and flags no clamp', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = 'development';
    expect(resolveDeploymentEnvResolution()).toEqual({ name: 'development', clamped: null });
  });
});

describe('resolveDeploymentEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The wrapper's whole contract: the resolution's name, and nothing else.
  it('returns the resolution name, dropping the clamp', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['NEXT_PUBLIC_VERCEL_ENV'] = 'production';

    expect(resolveDeploymentEnvResolution()).toEqual({ name: 'local', clamped: 'production' });
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

  it('registers the extension filter BEFORE calling the SDK init', () => {
    // Listener order is registration order, so this sequence is the whole
    // reason `stopImmediatePropagation()` can preempt the SDK. Asserting the
    // recorded boot order — rather than merely that both happened — is what
    // makes deleting the `installExtensionErrorFilter()` call fail a spec.
    expect(BOOT_ORDER).toEqual(['listener:error', 'listener:unhandledrejection', 'sdk.init']);
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

describe('syncFeatureFlagRumAttributes', () => {
  beforeEach(() => {
    signalAttributes.splice(0, signalAttributes.length, ...AFTER_INIT);
  });

  it('attaches one feature_flag.<key> attribute per entry, holding the variant', () => {
    syncFeatureFlagRumAttributes({
      'example-onboarding-flow': 'treatment',
      'example-usage-charts': 'off',
    });
    expect(valuesOf(`${FEATURE_FLAG_RUM_ATTRIBUTE_PREFIX}example-onboarding-flow`)).toEqual([
      'treatment',
    ]);
    expect(valuesOf(`${FEATURE_FLAG_RUM_ATTRIBUTE_PREFIX}example-usage-charts`)).toEqual(['off']);
  });

  it('does nothing for an empty flag map', () => {
    const before = signalAttributes.length;
    syncFeatureFlagRumAttributes({});
    expect(signalAttributes).toHaveLength(before);
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

  /**
   * An `EventTarget` that reproduces the `onerror` event-handler IDL attribute,
   * which node's bare `EventTarget` does not have.
   *
   * Two spec rules are modelled, and both are what the filter's ordering depends
   * on: the listener is added at the FIRST non-null assignment and keeps that
   * position for every later assignment, and assigning `null` removes it. This
   * is the path sdk-web 0.23.0 actually takes for uncaught errors — it ASSIGNS
   * `window.onerror` rather than adding an `error` listener — so a stand-in
   * built on `addEventListener` alone would prove nothing about the ordering.
   */
  class OnErrorEventTarget extends EventTarget {
    #handler: ((event: Event) => unknown) | null = null;
    #slot: ((event: Event) => void) | null = null;

    get onerror(): ((event: Event) => unknown) | null {
      return this.#handler;
    }

    set onerror(handler: ((event: Event) => unknown) | null) {
      this.#handler = handler;
      if (handler === null) {
        if (this.#slot) this.removeEventListener('error', this.#slot);
        this.#slot = null;
        return;
      }
      if (!this.#slot) {
        this.#slot = (event: Event) => this.#handler?.(event);
        this.addEventListener('error', this.#slot);
      }
    }
  }

  /** Subscribe a stand-in for the SDK, AFTER the filter, as `init()` does. */
  const attachSdkListener = (target: EventTarget, type: string) => {
    const listener = vi.fn();
    target.addEventListener(type, listener);
    return listener;
  };

  /**
   * Subscribe the SDK's uncaught-error path the way `init()` does — by ASSIGNING
   * `onerror`, after the filter is installed.
   */
  const attachSdkOnError = (target: OnErrorEventTarget) => {
    const listener = vi.fn();
    target.onerror = listener;
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

  it('hides an extension-only uncaught error from an SDK using window.onerror', () => {
    const target = new OnErrorEventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkOnError(target);

    dispatch(target, 'error', { error: { stack: EXTENSION_STACK } });

    expect(sdk).not.toHaveBeenCalled();
    teardown();
  });

  it('lets a first-party uncaught error reach an SDK using window.onerror', () => {
    const target = new OnErrorEventTarget();
    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkOnError(target);

    dispatch(target, 'error', { error: { stack: FIRST_PARTY_STACK } });

    expect(sdk).toHaveBeenCalledOnce();
    teardown();
  });

  it('outranks an onerror handler that was already set before the filter', () => {
    // The attribute's listener slot belongs to whoever assigned it first, so an
    // SDK assigning onerror AFTER us still inherits that earlier slot. The
    // filter re-seats the incumbent behind itself; without that, this is where
    // the uncaught-error half silently stops working.
    const target = new OnErrorEventTarget();
    const incumbent = vi.fn();
    target.onerror = incumbent;

    const teardown = installExtensionErrorFilter(target);
    const sdk = attachSdkOnError(target); // replaces the handler in the re-seated slot

    dispatch(target, 'error', { error: { stack: EXTENSION_STACK } });

    expect(sdk).not.toHaveBeenCalled();
    expect(incumbent).not.toHaveBeenCalled();

    dispatch(target, 'error', { error: { stack: FIRST_PARTY_STACK } });
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
