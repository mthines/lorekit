/**
 * The single browser RUM initialisation path for `@dash0/sdk-web`.
 *
 * ## Why this module exists
 *
 * The SDK used to be initialised from two places — `instrumentation-client.ts`
 * (module scope, runs on every page) and `Dash0Provider.tsx` (React effect,
 * dashboard only) — each with its own copy of the endpoint validator, the
 * deployment-env resolver, and the VCS attribute builder. The comment in
 * `instrumentation-client.ts` claimed the provider's `initialized` flag
 * prevented double-initialisation; it did not. That flag was a module-local in
 * a DIFFERENT module, so `init()` ran twice on every dashboard page load.
 *
 * Hoisting the singleton and the three helpers here is the repo's existing
 * functional-core convention (`otel-origins.ts`, `auth-redirect.ts`): one
 * dependency-light module with a co-located spec, imported by every surface,
 * so the copies cannot drift and the guard is actually shared.
 *
 * ## Identity is established at init, not after login
 *
 * {@link initDash0Rum} calls `identify()` with a stable anonymous visitor id
 * BEFORE the first event is emitted, and {@link identifyDash0User} upgrades it
 * to the authenticated Supabase user id once one is known. Identifying only on
 * login left every unauthenticated event — and the pre-hydration part of every
 * authenticated page load — with no `user.id`, which Dash0 folds into one
 * indistinguishable anonymous user. See `anonymous-id.ts` for the measurements.
 *
 * Kept free of React and `next/*` imports so `instrumentation-client.ts` (which
 * Next.js evaluates outside the React tree, and also server-side during static
 * prerendering) can import it as safely as a client component can.
 */
import { init, identify, addSignalAttribute } from '@dash0/sdk-web';

import { resolveAnonymousId } from './anonymous-id';
import { shouldIgnoreErrorFromExtension, stackOfUnknown } from './extension-errors';
import {
  deploymentEnvironmentClampMessage,
  resolveDeploymentEnvironment,
} from './otel-deployment-env';
import { supabaseOriginPattern } from './otel-origins';

/** OTel `service.name` for the browser bundle. Matches the server runtime. */
const SERVICE_NAME = 'web';

/**
 * Process-wide initialisation guard. Module-level (not per-component) so the
 * React provider and the Next.js client instrumentation hook share ONE flag —
 * the bug this module was extracted to fix.
 */
let initialized = false;

/**
 * Resolve `deployment.environment.name` from Vercel's env, cross-checked
 * against `NODE_ENV`.
 *
 * A plain `next dev` reports `local` only when no `VERCEL_ENV` reaches it. If
 * one does — `vercel env pull` writes `VERCEL_ENV=development` by default —
 * the dev server reports `development`, unclamped and unwarned, exactly as
 * `vercel dev` does; a pulled `production` / `preview` is the case that gets
 * clamped to `local` and warned about.
 *
 * Both env vars are read as literal member expressions because Next.js inlines
 * `NEXT_PUBLIC_*` and `NODE_ENV` reads at build time for the browser bundle — a
 * computed key would not be substituted.
 *
 * `NEXT_PUBLIC_VERCEL_ENV` is inlined from `VERCEL_ENV` (see `next.config.ts`),
 * which `vercel env pull` happily writes into a local `.env.local` — so it is
 * cross-checked against `NODE_ENV` to keep a dev build out of the production
 * environment. The decision itself lives in the shared pure module so the
 * browser and server halves cannot drift.
 *
 * Returns only the name. {@link resolveDeploymentEnvResolution} is the form
 * `initDash0Rum` uses, because it also needs to know whether a claimed
 * environment was clamped so it can warn about it exactly once, the way
 * `instrumentation.ts` does on the server side.
 *
 * @see ./otel-deployment-env.ts
 */
export function resolveDeploymentEnv(): string {
  return resolveDeploymentEnvResolution().name;
}

/**
 * The full {@link resolveDeploymentEnvironment} result for the browser bundle —
 * the resolved name plus the `VERCEL_ENV` value that was clamped away, if any.
 *
 * Kept side-effect free (the warning is the caller's job) so it stays a pure
 * read of the inlined env, and so importing this module never logs.
 */
export function resolveDeploymentEnvResolution() {
  return resolveDeploymentEnvironment(
    process.env['NEXT_PUBLIC_VERCEL_ENV'],
    process.env['NODE_ENV'],
  );
}

/**
 * Validate that the OTLP endpoint is an absolute HTTP(S) URL that is NOT the
 * current page's origin.
 *
 * A misconfigured `NEXT_PUBLIC_DASH0_OTLP_ENDPOINT` (set to `/`, or to the
 * Vercel deployment URL) makes the SDK POST telemetry back at the app, which
 * triggers CORS preflights against the app itself and fails with 400 on every
 * flush. Refusing to initialise is the quieter failure.
 *
 * @param url the configured endpoint, possibly undefined.
 * @param origin the current page origin; omit to read `window.location.origin`.
 */
export function isValidOtlpEndpoint(
  url: string | undefined,
  origin?: string,
): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const pageOrigin = origin ?? (typeof window === 'undefined' ? undefined : window.location.origin);
    if (pageOrigin !== undefined && parsed.origin === pageOrigin) {
      console.warn(
        '[Dash0] NEXT_PUBLIC_DASH0_OTLP_ENDPOINT points to the app origin — ' +
          'SDK initialisation skipped. Check Vercel env var configuration.',
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Build `vcs.*` signal attributes from the `NEXT_PUBLIC_VCS_*` vars that
 * `next.config.ts` bakes in at build time from Vercel's system env.
 *
 * Attributes are omitted when their source var is absent so the resource never
 * carries blank VCS fields.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
 */
export function buildVcsSignalAttributes(): Record<string, string> {
  const attrs: Record<string, string> = {};

  const owner = process.env['NEXT_PUBLIC_VCS_REPO_OWNER'];
  const slug = process.env['NEXT_PUBLIC_VCS_REPO_SLUG'];
  const refHeadName = process.env['NEXT_PUBLIC_VCS_REF_HEAD_NAME'];
  const refHeadRevision = process.env['NEXT_PUBLIC_VCS_REF_HEAD_REVISION'];

  if (owner && slug) {
    attrs['vcs.repository.url.full'] = `https://github.com/${owner}/${slug}`;
    attrs['vcs.repository.name'] = `${owner}/${slug}`;
  }
  if (refHeadName) {
    attrs['vcs.ref.head.name'] = refHeadName;
    attrs['vcs.ref.head.type'] = 'branch';
  }
  if (refHeadRevision) {
    attrs['vcs.ref.head.revision'] = refHeadRevision;
  }

  return attrs;
}

/** The `onerror` event-handler IDL attribute, on whatever we subscribe to. */
type OnErrorHost = { onerror?: unknown };

/**
 * Run `register` with any pre-existing `onerror` attribute handler temporarily
 * detached, then put it back — so it ends up registered AFTER `register`'s
 * listeners.
 *
 * `window.onerror` is an event-handler IDL attribute: its listener is added at
 * the FIRST non-null assignment and keeps that position forever, so a later
 * assignment (sdk-web 0.23.0 takes the uncaught-error path by ASSIGNING
 * `window.onerror`, not by adding a listener) reuses the slot the first setter
 * created. If anything on the page — a dev overlay, an analytics snippet — set
 * `onerror` before us, the SDK inherits that earlier slot and runs BEFORE our
 * filter, making the uncaught-error half of the filter a no-op.
 *
 * Assigning `null` removes that listener, and re-assigning the same function
 * registers it fresh at the end of the list. The handler identity is preserved,
 * so nothing that holds a reference to it notices; only the ordering moves.
 *
 * A host with no `onerror` property (a plain `EventTarget`, as in the specs) is
 * left untouched.
 */
function withOnErrorRegisteredLast(host: OnErrorHost, register: () => void): void {
  const existing = typeof host.onerror === 'function' ? host.onerror : null;
  if (existing) host.onerror = null;
  try {
    register();
  } finally {
    if (existing) host.onerror = existing;
  }
}

/**
 * Stop browser-extension errors from reaching the SDK's error instrumentation.
 *
 * ## Why this is a listener and not SDK config
 *
 * sdk-web 0.23.0 filters errors by MESSAGE only (`ignoreErrorMessages`), and
 * the extension messages we see are indistinguishable from real first-party
 * ones — see `extension-errors.ts` for the measurements. The stack is the only
 * reliable discriminator, and the sole point where we can act on it before the
 * SDK records the event is the DOM event itself.
 *
 * ## Why it must run before `init()`
 *
 * The SDK subscribes at `init()`: `window.addEventListener('unhandledrejection', …)`
 * for rejections, and an override of `window.onerror` for uncaught errors. Both
 * are listeners on `window`, which fire in registration order, so registering
 * FIRST is what lets `stopImmediatePropagation()` preempt them. Registering
 * after `init()` would be a silent no-op — the SDK would already have recorded
 * the event by the time we ran.
 *
 * Running first is necessary but not sufficient for the `onerror` half: that
 * attribute's slot belongs to whoever assigned it FIRST, so a pre-existing
 * `window.onerror` would still outrank us. `withOnErrorRegisteredLast` re-seats
 * it behind our listeners.
 *
 * `stopImmediatePropagation()` also hides these events from any other listener
 * on `window` (a dev overlay, say). That is intended: an error with no frame of
 * ours in it is not ours to surface. `preventDefault()` is deliberately NOT
 * called, so the browser still logs it to the console and the extension's own
 * error handling is untouched.
 *
 * @param target the event target to subscribe on; defaults to `window`.
 * @returns a teardown function removing both listeners, for tests.
 */
export function installExtensionErrorFilter(target?: EventTarget): () => void {
  const eventTarget = target ?? (typeof window === 'undefined' ? undefined : window);
  if (!eventTarget) return () => undefined;

  // Best-effort by design, and the SMALLER half of the win. A script served
  // from another origin — which every `chrome-extension://` script is — has its
  // uncaught errors MUTED by the browser: the page sees `message: "Script
  // error."` with `error: null` and `filename: ""`, and no `crossorigin`
  // attribute we control can un-mute an extension's own script tag. With
  // neither a stack nor a filename there is nothing to attribute, so those
  // events fall through to the fail-safe and are kept.
  //
  // Both production fingerprints (`M_ID`, MetaMask `inpage.js`) arrive as
  // unhandled REJECTIONS, whose `reason` is a real `Error` object with a full
  // stack and is not subject to the muting — that path is what removes the
  // 102/105. This branch stays for the hosts and cases that do report an
  // attributable uncaught error; it is never the thing to measure the filter by.
  const onError = (event: Event) => {
    const { error, filename } = event as ErrorEvent;
    if (shouldIgnoreErrorFromExtension({ stack: stackOfUnknown(error), filename })) {
      event.stopImmediatePropagation();
    }
  };

  const onRejection = (event: Event) => {
    const { reason } = event as PromiseRejectionEvent;
    if (shouldIgnoreErrorFromExtension({ stack: stackOfUnknown(reason) })) {
      event.stopImmediatePropagation();
    }
  };

  // Capture phase, so the listener is in place for events dispatched at
  // descendants of `window` as well as at `window` itself. Passed as an options
  // OBJECT rather than the legacy boolean: node's `EventTarget` — which the
  // specs run against — ignores a boolean `capture` on `removeEventListener`,
  // so the boolean form would leak the listener there.
  const capture = { capture: true } as const;

  // An `onerror` attribute handler that was already set holds a listener slot
  // ahead of anything we add now, and sdk-web's `init()` will reuse that slot
  // rather than appending — so re-register it behind us. See
  // `withOnErrorRegisteredLast`.
  withOnErrorRegisteredLast(eventTarget as OnErrorHost, () => {
    eventTarget.addEventListener('error', onError, capture);
    eventTarget.addEventListener('unhandledrejection', onRejection, capture);
  });

  return () => {
    eventTarget.removeEventListener('error', onError, capture);
    eventTarget.removeEventListener('unhandledrejection', onRejection, capture);
  };
}

/**
 * Initialise the Dash0 Web SDK exactly once per page load and identify the
 * visitor anonymously.
 *
 * Safe to call from as many entry points as you like — the second and later
 * calls are no-ops. Does nothing when the endpoint or auth token is missing or
 * invalid, which is the local-dev default.
 *
 * @returns `true` when this call performed the initialisation.
 */
export function initDash0Rum(): boolean {
  if (initialized) return false;

  const endpoint = process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'];
  const authToken = process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'];
  if (!isValidOtlpEndpoint(endpoint) || !authToken) return false;

  initialized = true;

  // BEFORE init(): the SDK subscribes to `unhandledrejection` and takes over
  // `window.onerror` inside init(), and listener order is registration order.
  installExtensionErrorFilter();

  // Warn once — `initialized` above makes this path run at most once per page —
  // when a pulled `VERCEL_ENV` claimed a deployment environment this dev build
  // is not in.
  //
  // This is the SECONDARY warning, not the one a developer will normally see:
  // the endpoint/token guard above returns early when RUM is unconfigured,
  // which is the local-dev default, so on the very machines a pulled
  // `VERCEL_ENV` misconfigures this line is usually unreachable. The server
  // half in `instrumentation.ts` has no such guard and is what actually warns
  // there. Kept anyway for the case that is not covered otherwise: a browser
  // bundle built with RUM configured but a clamped environment — a preview or
  // a local production build carrying pulled env.
  const deploymentEnv = resolveDeploymentEnvResolution();
  if (deploymentEnv.clamped) console.warn(deploymentEnvironmentClampMessage(deploymentEnv));

  init({
    serviceName: SERVICE_NAME,
    endpoint: { url: endpoint, authToken },
    additionalSignalAttributes: {
      'service.namespace': 'lorekit',
      'service.version': process.env['NEXT_PUBLIC_OTEL_SERVICE_VERSION'] ?? 'unknown',
      'deployment.environment.name': deploymentEnv.name,
      ...buildVcsSignalAttributes(),
    },
    // Propagate W3C trace context to Supabase — links browser spans to the
    // Edge Function spans they cause.
    propagateTraceHeadersCorsURLs: [supabaseOriginPattern()],
  });

  // Identify BEFORE anything is emitted, so no event ever ships without a
  // `user.id`. An authenticated visitor is re-identified by
  // `identifyDash0User` a few milliseconds later, once React has the session.
  //
  // `identify()` is the ONLY call that sets `user.id` here: it removes any
  // existing entry before adding one, whereas `addSignalAttribute` appends. A
  // paired `addSignalAttribute('user.id', …)` would leave two entries on every
  // signal — and, worse, `identify()` later removes only the FIRST of them, so
  // the anonymous id would survive the upgrade to the authenticated one.
  identify(resolveAnonymousId());

  return true;
}

/**
 * Upgrade the current identity to an authenticated Supabase user id.
 *
 * The anonymous id set at init stays in `localStorage` untouched, so
 * {@link resetDash0Identity} can return the visitor to the same anonymous
 * identity on sign-out rather than minting a new one and inflating the visitor
 * count.
 *
 * No-op before initialisation, so a caller never has to order its effects
 * against the SDK's readiness.
 *
 * `identify()` replaces the existing `user.id` rather than adding a second
 * one — see {@link initDash0Rum} for why it must not be paired with
 * `addSignalAttribute`.
 */
export function identifyDash0User(userId: string): void {
  if (!initialized || !userId) return;
  identify(userId);
}

/**
 * Return the visitor to the anonymous identity `initDash0Rum` assigned.
 *
 * Sign-out is a client-side `router.push` (`SignOutButton.tsx`), so there is no
 * page load to re-run initialisation: without this, every signal after sign-out
 * would keep carrying the signed-out `user.id` until the tab is reloaded.
 *
 * The anonymous id is read back from `localStorage`, so the visitor returns to
 * the SAME anonymous identity rather than being minted a new one.
 *
 * No-op before initialisation.
 */
export function resetDash0Identity(): void {
  if (!initialized) return;
  identify(resolveAnonymousId());
}

/**
 * The route is NOT set here. The SDK derives `page.url.path` itself, from
 * `window.location.href`, on every signal it emits (`addCommonAttributes` →
 * `addUrlAttributes` with the `page` prefix — sdk-web 0.23.0), and it reads the
 * location at emit time, so the value is already correct after a client-side
 * navigation. An app-side `addSignalAttribute('page.url.path', …)` only adds a
 * SECOND entry for the same key on every signal.
 */

/** Attribute-name prefix for the per-flag RUM tags {@link syncFeatureFlagRumAttributes} sets. */
export const FEATURE_FLAG_RUM_ATTRIBUTE_PREFIX = 'feature_flag.';

/**
 * Attach the current session's feature-flag state to every subsequent RUM
 * signal — page views, clicks, custom events, errors — via `addSignalAttribute`.
 *
 * ## Why this exists (the gap it closes)
 *
 * `@lorekit/feature-flags`' OTel hook (`packages/feature-flags/src/otel-hook.ts`)
 * only stamps `feature_flag.*` onto SERVER-SIDE spans, at the moment ONE flag
 * is evaluated. That answers "what did this one server-side evaluation
 * resolve to", but it is a different signal type and a different question
 * from what a Web Events / RUM view needs: "which flags were active for this
 * VISITOR, across every page view and click in their session" — for
 * correlating a variant to a conversion event days later. Nothing wired the
 * two together before this; a Web Events search for `feature_flag.*` found
 * nothing, because RUM signals never carried it.
 *
 * ## Why a DIFFERENT attribute shape than the OTel semconv hook uses
 *
 * The OTel feature-flag semantic conventions (`feature_flag.key` +
 * `feature_flag.result.variant`) are scoped to ONE evaluation on ONE span —
 * exactly one flag's outcome, once. A RUM session has MANY flags active at
 * once (every flag in the registry, potentially), so reusing those same fixed
 * attribute names would mean every flag after the first OVERWRITES the one
 * before it under the identical key. There is no OTel-standard shape for
 * "here is the whole set of concurrently active flags" — this uses one
 * DYNAMIC attribute name per flag instead: `feature_flag.<flagKey>` = the
 * variant. Non-standard, but the only representation that doesn't collide,
 * and it is what makes `feature_flag.example-onboarding-flow = "treatment"` a
 * filterable/groupable dimension on the Web Events / RUM explorer — compare
 * conversion-event rates between `feature_flag.example-onboarding-flow =
 * "control"` and `"treatment"` sessions directly.
 *
 * ## What is attached — the VARIANT, never the raw value
 *
 * Always the short, human-readable variant key (`"treatment"`, `"beta"`),
 * never an `object`-typed flag's whole payload — the same "prefer `variant`
 * over `value`" reasoning `otel-attributes.ts` documents for the span hook:
 * an object value is unbounded size and not a useful grouping dimension.
 *
 * ## Call site and lifecycle
 *
 * Called from `FeatureFlagsProvider` (a `useEffect`, so it re-runs whenever
 * the server re-evaluates flags — e.g. after a session-override change) with
 * the variant map `getAllServerFlagVariants()` (`lib/feature-flags/server.ts`)
 * produced. No-op before RUM init, like every other function in this module —
 * a flag evaluated during static prerendering (no browser, no SDK) has
 * nothing to attach to yet; the next real page load calls this again anyway.
 */
export function syncFeatureFlagRumAttributes(flagVariants: Readonly<Record<string, string>>): void {
  if (!initialized) return;
  for (const [flagKey, variant] of Object.entries(flagVariants)) {
    addSignalAttribute(`${FEATURE_FLAG_RUM_ATTRIBUTE_PREFIX}${flagKey}`, variant);
  }
}
