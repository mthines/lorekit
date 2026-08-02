import { describe, it, expect } from 'vitest';
import {
  ANONYMOUS_ID_PREFIX,
  ANONYMOUS_ID_STORAGE_KEY,
  isAnonymousId,
  resolveAnonymousId,
  type AnonymousIdStorage,
} from './anonymous-id';

/** In-memory `Storage` stub; `onGet` / `onSet` opt into the throwing paths. */
function fakeStorage(
  seed: Record<string, string> = {},
  hooks: { onGet?: () => void; onSet?: () => void } = {},
): AnonymousIdStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem(key) {
      hooks.onGet?.();
      return key in data ? (data[key] as string) : null;
    },
    setItem(key, value) {
      hooks.onSet?.();
      data[key] = value;
    },
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('isAnonymousId', () => {
  it('accepts a prefixed id', () => {
    expect(isAnonymousId('anon:2f1d0a5e-1b0e-4c2f-9a3d-5f6e7a8b9c0d')).toBe(true);
  });

  it('rejects an unprefixed value, including a bare Supabase user id', () => {
    expect(isAnonymousId('f6e06f93-9dd2-41cf-89f1-71e0e97461d9')).toBe(false);
  });

  it('rejects the bare prefix with no id after it', () => {
    expect(isAnonymousId(ANONYMOUS_ID_PREFIX)).toBe(false);
  });

  it('rejects empty, null, and undefined', () => {
    expect(isAnonymousId('')).toBe(false);
    expect(isAnonymousId(null)).toBe(false);
    expect(isAnonymousId(undefined)).toBe(false);
  });
});

describe('resolveAnonymousId', () => {
  it('mints a prefixed v4 UUID and persists it when storage is empty', () => {
    const store = fakeStorage();
    const id = resolveAnonymousId(store);

    expect(isAnonymousId(id)).toBe(true);
    expect(id.slice(ANONYMOUS_ID_PREFIX.length)).toMatch(UUID_V4);
    expect(store.data[ANONYMOUS_ID_STORAGE_KEY]).toBe(id);
  });

  it('is stable across calls — the whole point of the module', () => {
    const store = fakeStorage();
    const first = resolveAnonymousId(store);
    const second = resolveAnonymousId(store);

    expect(second).toBe(first);
  });

  it('returns the already-stored id without rewriting it', () => {
    const stored = 'anon:2f1d0a5e-1b0e-4c2f-9a3d-5f6e7a8b9c0d';
    const store = fakeStorage(
      { [ANONYMOUS_ID_STORAGE_KEY]: stored },
      {
        onSet: () => {
          throw new Error('must not write when a valid id is already stored');
        },
      },
    );

    expect(resolveAnonymousId(store)).toBe(stored);
  });

  it('replaces a stored value that is not one of ours', () => {
    // A bare UUID here would merge this visitor with a real authenticated user.
    const store = fakeStorage({ [ANONYMOUS_ID_STORAGE_KEY]: 'f6e06f93-9dd2-41cf-89f1-71e0e97461d9' });
    const id = resolveAnonymousId(store);

    expect(isAnonymousId(id)).toBe(true);
    expect(store.data[ANONYMOUS_ID_STORAGE_KEY]).toBe(id);
  });

  it('replaces a stored empty string', () => {
    const store = fakeStorage({ [ANONYMOUS_ID_STORAGE_KEY]: '' });

    expect(isAnonymousId(resolveAnonymousId(store))).toBe(true);
  });

  it('returns an ephemeral id when getItem throws (blocked storage)', () => {
    const store = fakeStorage(
      {},
      {
        onGet: () => {
          throw new Error('SecurityError');
        },
      },
    );

    expect(isAnonymousId(resolveAnonymousId(store))).toBe(true);
  });

  it('returns an ephemeral id when setItem throws (private mode quota)', () => {
    const store = fakeStorage(
      {},
      {
        onSet: () => {
          throw new Error('QuotaExceededError');
        },
      },
    );

    expect(isAnonymousId(resolveAnonymousId(store))).toBe(true);
  });

  it('returns an ephemeral id when there is no storage at all (SSR)', () => {
    // No injected storage and no `window` in the node test environment.
    const id = resolveAnonymousId();

    expect(isAnonymousId(id)).toBe(true);
    expect(id.slice(ANONYMOUS_ID_PREFIX.length)).toMatch(UUID_V4);
  });
});
