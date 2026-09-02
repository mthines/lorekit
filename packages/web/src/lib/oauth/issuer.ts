/**
 * Which origin does THIS deployment advertise as its authorization server?
 *
 * The discovery documents name the endpoints a client will call next, so the
 * origin in them has to be the one the client can actually reach. Getting it
 * from a single env var does not work across our four environments:
 *
 *   production  NEXT_PUBLIC_APP_URL = https://lorekit.io                 ✅
 *   local       NEXT_PUBLIC_APP_URL = http://localhost:3001 (.env.local)  ✅
 *   git-push
 *   preview     NEXT_PUBLIC_APP_URL is pulled from Vercel — still the
 *               PRODUCTION value, so the document would send clients to
 *               production from a preview build                          ❌
 *   /preview    the workflow deploys prebuilt via the Vercel CLI, where
 *   workflow    neither VERCEL_BRANCH_URL nor VERCEL_URL is populated at
 *               build time (see the NEXT_PUBLIC_VERCEL_URL comment in
 *               next.config.ts), so nothing build-time knows the origin    ❌
 *
 * Hence a ladder, with the request as the last resort — which is also the
 * semantically right answer for a discovery document: it describes the server
 * you just fetched it from.
 *
 * CACHING IS COUPLED TO THIS CHOICE. A request-derived origin comes from a
 * header the caller controls, so a shared CDN cache could be poisoned by one
 * crafted request into serving an attacker's origin to everyone. The resolver
 * therefore reports HOW it decided, and the routes send `no-store` whenever
 * the answer came from the request. Configured answers stay cacheable. Never
 * make a derived document cacheable to "save a hit".
 *
 * Pure: env and request origin are arguments. No `process.env` read, no
 * `next/*` import.
 */

import { DEFAULT_ISSUER } from './metadata';

export interface IssuerEnv {
  /** `VERCEL_ENV` — 'production' | 'preview' | 'development' | undefined. */
  vercelEnv?: string | undefined;
  /** The configured canonical origin. Production/local truth. */
  appUrl?: string | undefined;
  /** next.config.ts's ladder: the stable branch alias on a preview build. */
  vercelUrl?: string | undefined;
}

export interface ResolvedIssuer {
  issuer: string;
  /**
   * True when the origin came from the request rather than configuration.
   * The routes turn this into `Cache-Control: no-store`.
   */
  derivedFromRequest: boolean;
}

/** Strip a trailing slash so the document never emits a doubled one. */
function normalize(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function usable(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve the issuer for a discovery document.
 *
 * @param env           the deployment's environment
 * @param requestOrigin the origin the document was fetched from, when known
 */
export function resolveIssuer(env: IssuerEnv, requestOrigin?: string | null): ResolvedIssuer {
  const isPreview = env.vercelEnv === 'preview';

  // On a preview, the branch alias is the only CONFIGURED value that is
  // actually reachable — NEXT_PUBLIC_APP_URL still holds production.
  if (isPreview) {
    if (usable(env.vercelUrl)) {
      return { issuer: normalize(env.vercelUrl), derivedFromRequest: false };
    }
    if (usable(requestOrigin)) {
      return { issuer: normalize(requestOrigin), derivedFromRequest: true };
    }
    // Deliberately NOT falling through to NEXT_PUBLIC_APP_URL, which still
    // holds PRODUCTION on a preview build: advertising production endpoints
    // from a preview silently mints a token for the wrong deployment.
    //
    // Reaching here means neither the branch alias nor a request origin was
    // available, which a route handler cannot do (a request always has an
    // origin). A total function still has to return something, and a document
    // must be emitted, so the default it is.
    return { issuer: DEFAULT_ISSUER, derivedFromRequest: false };
  }

  if (usable(env.appUrl)) {
    return { issuer: normalize(env.appUrl), derivedFromRequest: false };
  }
  if (usable(requestOrigin)) {
    return { issuer: normalize(requestOrigin), derivedFromRequest: true };
  }
  return { issuer: DEFAULT_ISSUER, derivedFromRequest: false };
}

/** Cache headers matching how the issuer was decided. */
export function issuerCacheControl(resolved: ResolvedIssuer): string {
  return resolved.derivedFromRequest
    ? 'no-store'
    : 'public, max-age=300, s-maxage=3600';
}
