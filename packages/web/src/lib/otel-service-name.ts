/**
 * Reconcile the code-declared OTel `service.name` with the `OTEL_SERVICE_NAME`
 * environment variable, which silently outranks it.
 *
 * ## The bug this exists to prevent
 *
 * `@vercel/otel` resolves the service name as:
 *
 * ```js
 * let a = e.OTEL_SERVICE_NAME || t.serviceName || "app";
 * ```
 *
 * (`dist/node/index.js`, v1.13.0 — `e` is the parsed environment, `t` the
 * `registerOTel` config). The env var WINS. So `registerOTel({ serviceName:
 * 'web' })` is inert on any deployment that also sets `OTEL_SERVICE_NAME`, and
 * the OTel env resource detector independently applies the same var, so there
 * is no config-side way to out-rank it.
 *
 * Observed in production: the Next.js server runtime reported
 * `service.name = 'lorekit'` — the `service.namespace` value — for 326 spans in
 * a 6h window (`POST /lore`, `resolve page components`, PostgREST fetches),
 * while the browser bundle correctly reported `web`. One application appeared
 * as two unrelated nodes in the service map, and the server half collided with
 * the product namespace shared by every other component. `OTEL_SERVICE_NAME` is
 * the documented way to name the Node MCP server (`mcp`), so a project-wide
 * value is an easy and invisible mistake to make.
 *
 * ## The rule
 *
 * **A component's `service.name` is a property of the code, not of the
 * deployment.** `CLAUDE.md`'s service inventory assigns each component exactly
 * one name and warns that a collision "collapses two components into one
 * indistinguishable node in the service map". An env var that can rename a
 * service after the fact makes that inventory unenforceable, so the code
 * asserts its own name and reports the conflict rather than losing silently.
 *
 * This mirrors the decision already recorded for the Edge Functions — "do not
 * reintroduce a per-function `SERVICE_NAME` secret… one value can never name
 * five functions" — applied to the one component where the env var still wins.
 *
 * Dependency-free (no React, no `next/*`, no node builtins) so it is unit
 * testable and safe in any runtime.
 */

/** Conflict between the declared service name and the environment's. */
export interface ServiceNameResolution {
  /** The name to enforce — always the code-declared one. */
  name: string;
  /**
   * The conflicting `OTEL_SERVICE_NAME` value that was overridden, or `null`
   * when the env var was absent or already agreed. Non-null means a deployment
   * misconfiguration a human should clear up.
   */
  overridden: string | null;
}

/**
 * Decide the effective service name and whether an env value was overridden.
 *
 * Total function — an empty or whitespace-only env value is treated as absent
 * rather than as a conflict, because `OTEL_SERVICE_NAME=` (set but blank) is a
 * common way to "unset" a variable in a deployment UI and is not a name anyone
 * intended.
 *
 * @param declared the name this component asserts (e.g. `web`).
 * @param envValue the raw `OTEL_SERVICE_NAME`, if any.
 */
export function resolveServiceName(
  declared: string,
  envValue: string | undefined | null,
): ServiceNameResolution {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  const conflicts = trimmed.length > 0 && trimmed !== declared;
  return { name: declared, overridden: conflicts ? trimmed : null };
}

/** Message describing an overridden env value, for a one-time warning. */
export function serviceNameConflictMessage(resolution: ServiceNameResolution): string {
  return (
    `[otel] OTEL_SERVICE_NAME is set to "${resolution.overridden}" but this component is ` +
    `"${resolution.name}". @vercel/otel lets the environment variable win over the ` +
    `serviceName option, which would report this service under the wrong name and split ` +
    `it from its browser half in the service map. Forcing "${resolution.name}" — ` +
    `remove OTEL_SERVICE_NAME from this project's environment to silence this warning.`
  );
}
