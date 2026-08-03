import { describe, it, expect } from 'vitest';
import { resolveServiceName, serviceNameConflictMessage } from './otel-service-name';

describe('resolveServiceName', () => {
  it('always returns the declared name, whatever the environment says', () => {
    expect(resolveServiceName('web', undefined).name).toBe('web');
    expect(resolveServiceName('web', 'lorekit').name).toBe('web');
    expect(resolveServiceName('web', 'anything-at-all').name).toBe('web');
  });

  it('reports no conflict when the env var is absent', () => {
    expect(resolveServiceName('web', undefined).overridden).toBeNull();
    expect(resolveServiceName('web', null).overridden).toBeNull();
  });

  it('reports no conflict when the env var already agrees', () => {
    expect(resolveServiceName('web', 'web').overridden).toBeNull();
  });

  it('treats a blank env value as absent, not as a conflict', () => {
    // `OTEL_SERVICE_NAME=` is how a deployment UI "unsets" a variable — nobody
    // intended the empty string as a service name.
    expect(resolveServiceName('web', '').overridden).toBeNull();
    expect(resolveServiceName('web', '   ').overridden).toBeNull();
  });

  it('reports the real production conflict', () => {
    // The server runtime reported `lorekit` (the service.namespace) for 326
    // spans while the browser reported `web`.
    expect(resolveServiceName('web', 'lorekit')).toEqual({ name: 'web', overridden: 'lorekit' });
  });

  it('trims the env value before comparing and reporting', () => {
    expect(resolveServiceName('web', '  web  ').overridden).toBeNull();
    expect(resolveServiceName('web', '  lorekit  ').overridden).toBe('lorekit');
  });
});

describe('serviceNameConflictMessage', () => {
  it('names both the wrong value and the enforced one', () => {
    const message = serviceNameConflictMessage({ name: 'web', overridden: 'lorekit' });

    expect(message).toContain('"lorekit"');
    expect(message).toContain('"web"');
    expect(message).toContain('OTEL_SERVICE_NAME');
  });
});
