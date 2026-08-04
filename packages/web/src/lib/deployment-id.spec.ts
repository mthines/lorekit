import { describe, it, expect } from 'vitest';
import { resolveDeploymentId, DEPLOYMENT_ID_ENV } from './deployment-id';

describe('resolveDeploymentId', () => {
  it('returns the deployment ID Vercel injected', () => {
    // The real production shape: `dpl_…`, as seen on the deployment that
    // answered the 404 Server Action POSTs.
    expect(resolveDeploymentId({ [DEPLOYMENT_ID_ENV]: 'dpl_D6ZoEHfkh13jtPkQerya1JT3L6PP' })).toBe(
      'dpl_D6ZoEHfkh13jtPkQerya1JT3L6PP',
    );
  });

  it('is undefined when the variable is absent', () => {
    // Local dev and any build made before Skew Protection is switched on for
    // the project. Next.js must see `undefined`, not a falsy string, so it
    // leaves asset URLs and Server Action requests unstamped.
    expect(resolveDeploymentId({})).toBeUndefined();
    expect(resolveDeploymentId({ [DEPLOYMENT_ID_ENV]: undefined })).toBeUndefined();
  });

  it('treats a blank value as absent, not as a deployment ID', () => {
    // `VERCEL_DEPLOYMENT_ID=` is how a deployment UI "unsets" a variable.
    // Passing '' through would stamp `?dpl=` onto every asset URL and buy
    // nothing — the same rule `resolveServiceName` applies to OTEL_SERVICE_NAME.
    expect(resolveDeploymentId({ [DEPLOYMENT_ID_ENV]: '' })).toBeUndefined();
    expect(resolveDeploymentId({ [DEPLOYMENT_ID_ENV]: '   ' })).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(resolveDeploymentId({ [DEPLOYMENT_ID_ENV]: '  dpl_abc123  ' })).toBe('dpl_abc123');
  });

  it('ignores unrelated variables', () => {
    expect(resolveDeploymentId({ VERCEL_URL: 'lorekit.vercel.app' })).toBeUndefined();
  });
});
