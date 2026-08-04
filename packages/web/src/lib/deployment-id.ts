/**
 * Resolve the Vercel deployment ID that Next.js pins a browser bundle to
 * (Skew Protection).
 *
 * ## Why this exists
 *
 * Next.js Server Actions are invoked as a `POST` to the page route that hosts
 * them (`POST /dashboard` for the actions behind the Overview's invite banner
 * and onboarding checklist — see the note in `src/middleware.ts`). The action
 * is addressed by an **action ID that is minted at build time** and is only
 * known to the deployment that produced the bundle.
 *
 * `deploy.yml` flips production with a Vercel **alias swap** on every push to
 * `main` (docs/deployment.md → "FE ↔ API deploy in lockstep"). The swap is
 * instant and does not touch tabs that are already open: a browser that loaded
 * the dashboard from build A keeps running build A's JavaScript, while
 * `www.lorekit.io` now resolves to build B. The next Server Action that tab
 * fires posts build A's action ID to build B, which has never heard of it and
 * answers **404**. The user sees a dead Accept / Decline / onboarding button
 * with no error message, and it stays dead until they hard-reload.
 *
 * Setting `deploymentId` is Next.js's supported hook for this: it stamps the
 * deployment ID onto asset URLs and Server Action requests, and Vercel's Skew
 * Protection routes a stamped request back to the deployment that served the
 * bundle instead of to whatever the alias currently points at.
 *
 * ## Requires the Vercel project setting
 *
 * The code half is necessary but not sufficient — **Skew Protection must also
 * be enabled for the Vercel project** (Settings → Advanced → Skew Protection).
 * Vercel then injects `VERCEL_DEPLOYMENT_ID` into the build and honours the
 * stamp at the edge. Without the setting the variable is absent, this resolves
 * to `undefined`, and the behaviour is exactly what it is today — so the change
 * is safe to land ahead of (or without) the setting.
 *
 * Kept as a tiny pure module rather than an inline expression in
 * `next.config.ts` so the "blank means unset" rule is testable: a deployment UI
 * "unsets" a variable by assigning the empty string, and an empty `deploymentId`
 * would stamp `?dpl=` onto every asset URL for no benefit.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId
 * @see https://vercel.com/docs/skew-protection
 */

/** The Vercel system env var carrying the current deployment's ID. */
export const DEPLOYMENT_ID_ENV = 'VERCEL_DEPLOYMENT_ID';

/**
 * Read the deployment ID out of an environment bag.
 *
 * @param env - the environment to read from (`process.env` in production).
 * @returns the trimmed deployment ID, or `undefined` when it is absent or
 *   blank — which is the value `next.config.ts` must pass so Next.js leaves
 *   asset URLs and Server Action requests unstamped.
 */
export function resolveDeploymentId(
  env: Record<string, string | undefined>,
): string | undefined {
  const value = env[DEPLOYMENT_ID_ENV];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
