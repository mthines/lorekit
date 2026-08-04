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
 * ## Not sufficient on its own — two prerequisites are still open
 *
 * `VERCEL_DEPLOYMENT_ID` only exists in a build that Vercel itself runs, on a
 * project with Skew Protection switched on. Two things must change before this
 * helper can ever return a value in production:
 *
 * 1. **The project settings.** Skew Protection (Settings → Advanced) *and*
 *    "Enable access to System Environment Variables" (Settings → Environment
 *    Variables) both have to be on — the latter is what actually exposes
 *    `VERCEL_*` system variables to the build.
 * 2. **The production build has to move onto Vercel's builders.**
 *    `stage-web-production` in `deploy.yml` runs `vercel build --prod` inside
 *    GitHub Actions and then `vercel deploy --prebuilt`. A deployment ID is
 *    assigned at *upload* time, so during that build it does not exist yet and
 *    no amount of project configuration will inject it. Prebuilt deployments
 *    therefore cannot participate in Skew Protection.
 *
 * Until both hold, this resolves to `undefined`, `deploymentId` is unset, and
 * behaviour is exactly what it is today — so the wiring is safe to land ahead of
 * the decision, but it does **not** fix the 404s by itself. See
 * `docs/deployment.md` → "Skew Protection".
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
