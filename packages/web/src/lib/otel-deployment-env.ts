/**
 * Resolve the OTel `deployment.environment.name` for the `web` component from
 * Vercel's `VERCEL_ENV` — cross-checked against `NODE_ENV` so a developer's
 * machine can never label itself `production`.
 *
 * ## The bug this exists to prevent
 *
 * `VERCEL_ENV` is a *value*, not a proof of where the process runs. `vercel env
 * pull` writes the selected environment's variables — including
 * `VERCEL_ENV=production` — straight into a local `.env.local`, and Next.js
 * loads that file for `next dev` like any other. From that moment a laptop's
 * dev server stamps every span `deployment.environment.name=production`.
 *
 * Observed in production alerting: the `web` service reported a 12 % SERVER
 * error ratio under `deployment_environment_name="production"`, tripping the
 * "Web — high backend error rate" check rule. Every failing span was a
 * Turbopack dev-server artefact — `ENOENT ... .next/server/app/(auth)/login/
 * page/app-build-manifest.json` thrown from `next/dist/server/dev/*` on a
 * `/Users/...` path — on a resource that also carried `node.env=development`.
 * Nothing was wrong with the deployed site; the alert was firing on somebody's
 * laptop, and no amount of application-code fixing would have silenced it.
 *
 * ## The rule
 *
 * **`deployment.environment.name` describes where the process is running, so
 * it must be derived from something the process cannot be handed in a file.**
 * `NODE_ENV` is that thing: a real Vercel production or preview deployment
 * serves a `next build` output with `NODE_ENV=production`, while `next dev` and
 * `vercel dev` always run with `NODE_ENV=development`. So a non-production
 * `NODE_ENV` is conclusive evidence that this is a dev server, whatever
 * `VERCEL_ENV` claims, and `production` / `preview` are clamped away.
 *
 * ## Known residual, and why `VERCEL` is deliberately not also checked
 *
 * A local `next build && next start` with a pulled `VERCEL_ENV=production` sets
 * `NODE_ENV=production` and so is still reported as `production`. Gating
 * additionally on Vercel's `VERCEL` variable would not close that hole:
 * `vercel env pull` writes the system variables too, `VERCEL=1` among them, so
 * the same `.env.local` that supplies the bad `VERCEL_ENV` supplies a matching
 * `VERCEL`. It would, however, add a way for a real deployment to be
 * mis-detected as local if that variable ever stops reaching the Next.js server
 * runtime — a silent loss of production telemetry, which is the worse failure.
 *
 * The residual is accepted because running a production build against pulled
 * production credentials is a deliberate, rare act, whereas `next dev` is what
 * every contributor runs all day — and `next dev` is what caused the incident.
 *
 * This mirrors `otel-service-name.ts`, which exists for the same shape of bug —
 * an environment variable silently outranking the code and mislabelling a
 * component's telemetry — and is deliberately written the same way: a total,
 * dependency-free pure function plus a message builder for a one-time warning.
 *
 * Dependency-free (no React, no `next/*`, no node builtins) so it is unit
 * testable and safe in both the Node.js runtime and the browser bundle.
 *
 * Recorded as a do-not-relitigate decision alongside its sibling rule — see
 * `docs/decisions.md` → "VERCEL_ENV must never decide the deployment
 * environment alone", indexed from the root `CLAUDE.md` → Key decisions.
 */

/** The four environments the `web` component reports. */
export type DeploymentEnvironment = 'production' | 'preview' | 'development' | 'local';

/** Outcome of reconciling `VERCEL_ENV` with `NODE_ENV`. */
export interface DeploymentEnvironmentResolution {
  /** The value to stamp on the resource. */
  name: DeploymentEnvironment;
  /**
   * The `VERCEL_ENV` value that was clamped away because `NODE_ENV` proved this
   * is a dev server, or `null` when nothing was clamped. Non-null means a local
   * environment file is carrying deployment variables a human should clear up.
   */
  clamped: string | null;
}

/**
 * Map a raw `VERCEL_ENV` to a deployment environment, ignoring `NODE_ENV`.
 *
 * An unrecognised value falls back to `local` rather than being passed through,
 * so a typo can never invent a new environment in the telemetry.
 */
function mapVercelEnv(vercelEnv: string | undefined | null): DeploymentEnvironment {
  if (vercelEnv === 'production') return 'production';
  if (vercelEnv === 'preview') return 'preview';
  if (vercelEnv === 'development') return 'development';
  return 'local';
}

/**
 * Decide the effective `deployment.environment.name` and whether a claimed
 * deployment environment was clamped.
 *
 * Total function. When `NODE_ENV` is anything other than `production` the
 * process is a dev server, so the result is narrowed to `development` (that is
 * what `vercel dev` genuinely is) or `local` — never `production` or `preview`.
 *
 * @param vercelEnv the raw `VERCEL_ENV` (or `NEXT_PUBLIC_VERCEL_ENV` in the
 *   browser bundle), if any.
 * @param nodeEnv the raw `NODE_ENV`, if any.
 */
export function resolveDeploymentEnvironment(
  vercelEnv: string | undefined | null,
  nodeEnv: string | undefined | null,
): DeploymentEnvironmentResolution {
  const claimed = mapVercelEnv(vercelEnv);

  if (nodeEnv === 'production') return { name: claimed, clamped: null };

  // A dev server. `vercel dev` legitimately reports `development`; everything
  // else on a developer's machine is `local`.
  const name: DeploymentEnvironment = claimed === 'development' ? 'development' : 'local';
  const isClamped = claimed === 'production' || claimed === 'preview';

  return { name, clamped: isClamped ? claimed : null };
}

/** Message describing a clamped deployment environment, for a one-time warning. */
export function deploymentEnvironmentClampMessage(
  resolution: DeploymentEnvironmentResolution,
): string {
  return (
    `[otel] VERCEL_ENV claims "${resolution.clamped}" but NODE_ENV is not "production", ` +
    `so this process is a dev server. Reporting deployment.environment.name as ` +
    `"${resolution.name}" instead — otherwise this machine's telemetry would land in ` +
    `production dashboards and fire production alerts. Remove VERCEL_ENV from your ` +
    `local .env files (\`vercel env pull\` writes it) to silence this warning.`
  );
}
