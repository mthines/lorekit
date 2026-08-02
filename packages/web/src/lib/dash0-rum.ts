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
import { init, addSignalAttribute, identify } from '@dash0/sdk-web';

import { resolveAnonymousId } from './anonymous-id';
import { supabaseOriginPattern } from './otel-origins';

/** OTel `service.name` for the browser bundle. Matches the server runtime. */
const SERVICE_NAME = 'web';

/**
 * Process-wide initialisation guard. Module-level (not per-component) so the
 * React provider and the Next.js client instrumentation hook share ONE flag —
 * the bug this module was extracted to fix.
 */
let initialized = false;

/** Whether {@link initDash0Rum} has successfully initialised the SDK. */
export function isDash0RumInitialized(): boolean {
  return initialized;
}

/**
 * Resolve `deployment.environment.name` from Vercel's env, defaulting to
 * `local` for a plain `next dev`.
 *
 * The env var is read as a literal member expression because Next.js inlines
 * `NEXT_PUBLIC_*` reads at build time for the browser bundle — a computed key
 * would not be substituted.
 */
export function resolveDeploymentEnv(): string {
  const env = process.env['NEXT_PUBLIC_VERCEL_ENV'];
  if (env === 'production') return 'production';
  if (env === 'preview') return 'preview';
  if (env === 'development') return 'development';
  return 'local';
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

  init({
    serviceName: SERVICE_NAME,
    endpoint: { url: endpoint, authToken },
    additionalSignalAttributes: {
      'service.namespace': 'lorekit',
      'service.version': process.env['NEXT_PUBLIC_OTEL_SERVICE_VERSION'] ?? 'unknown',
      'deployment.environment.name': resolveDeploymentEnv(),
      ...buildVcsSignalAttributes(),
    },
    // Propagate W3C trace context to Supabase — links browser spans to the
    // Edge Function spans they cause.
    propagateTraceHeadersCorsURLs: [supabaseOriginPattern()],
  });

  // Identify BEFORE anything is emitted, so no event ever ships without a
  // `user.id`. An authenticated visitor is re-identified by
  // `identifyDash0User` a few milliseconds later, once React has the session.
  const anonymousId = resolveAnonymousId();
  identify(anonymousId);
  addSignalAttribute('user.id', anonymousId);

  if (typeof window !== 'undefined') {
    addSignalAttribute('page.url.path', window.location.pathname);
  }

  return true;
}

/**
 * Upgrade the current identity to an authenticated Supabase user id.
 *
 * The anonymous id set at init stays in `localStorage` untouched, so a sign-out
 * returns the visitor to the same anonymous identity rather than minting a new
 * one and inflating the visitor count.
 *
 * No-op before initialisation, so a caller never has to order its effects
 * against the SDK's readiness.
 */
export function identifyDash0User(userId: string): void {
  if (!initialized || !userId) return;
  identify(userId);
  addSignalAttribute('user.id', userId);
}

/**
 * Record the current route on all subsequent signals.
 *
 * No-op before initialisation.
 */
export function setDash0PagePath(path: string): void {
  if (!initialized) return;
  addSignalAttribute('page.url.path', path);
}
