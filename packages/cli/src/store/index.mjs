// Store factory: build the store the resolved control model selects.
// Returns null for `off` — callers short-circuit `off` before reaching here,
// so a no-op store object is unnecessary.
import { createLocalStore } from './local.mjs';
import { createRemoteStore } from './remote.mjs';

export function createStore(control) {
  if (!control || control.mode === 'off') return null;
  if (control.mode === 'local') return createLocalStore(control.storeTarget);
  if (control.mode === 'remote') {
    const conn = control.connection || {};
    return createRemoteStore({ endpoint: conn.endpoint, token: conn.token });
  }
  return null;
}

export { createLocalStore, createRemoteStore };
