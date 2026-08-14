import { describe, it, expect, afterEach } from 'vitest';
import {
  isLocalModeServer,
  isLocalModeBrowser,
  LOCAL_MODE_TOKEN,
  LOCAL_MODE_USER,
} from './local-mode';

afterEach(() => {
  delete process.env['LOREKIT_LOCAL_MODE'];
  delete process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'];
});

describe('isLocalModeServer', () => {
  it('is true only for the exact string "1"', () => {
    process.env['LOREKIT_LOCAL_MODE'] = '1';
    expect(isLocalModeServer()).toBe(true);
  });

  it('INVARIANT: is false when unset — production auth is untouched', () => {
    expect(isLocalModeServer()).toBe(false);
  });

  it.each(['0', 'true', 'yes', '', ' 1', '1 '])(
    'is false for the truthy-looking but non-"1" value %j (no accidental enable)',
    (value) => {
      process.env['LOREKIT_LOCAL_MODE'] = value;
      expect(isLocalModeServer()).toBe(false);
    },
  );

  it('reads only the server flag, never the browser one', () => {
    process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] = '1';
    expect(isLocalModeServer()).toBe(false);
  });
});

describe('isLocalModeBrowser', () => {
  it('is true only for the exact string "1"', () => {
    process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] = '1';
    expect(isLocalModeBrowser()).toBe(true);
  });

  it('INVARIANT: is false when unset — the production bundle cannot contain the branch', () => {
    expect(isLocalModeBrowser()).toBe(false);
  });

  it.each(['0', 'true', 'yes', ''])('is false for the non-"1" value %j', (value) => {
    process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] = value;
    expect(isLocalModeBrowser()).toBe(false);
  });

  it('reads only the browser flag, never the server one — the two are deliberately distinct (D3)', () => {
    process.env['LOREKIT_LOCAL_MODE'] = '1';
    expect(isLocalModeBrowser()).toBe(false);
  });
});

describe('LOCAL_MODE_TOKEN', () => {
  it('is a non-empty string — the shim only requires it survive as a Bearer value', () => {
    expect(typeof LOCAL_MODE_TOKEN).toBe('string');
    expect(LOCAL_MODE_TOKEN.length).toBeGreaterThan(0);
  });
});

describe('LOCAL_MODE_USER', () => {
  it('carries the exact fields the dashboard chrome reads (id / email / user_metadata)', () => {
    expect(LOCAL_MODE_USER.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(LOCAL_MODE_USER.email).toBe('local@lorekit.dev');
    expect(LOCAL_MODE_USER.user_metadata['full_name']).toBe('Local dev');
  });

  it('presents as an authenticated user so no surface special-cases "no session"', () => {
    expect(LOCAL_MODE_USER.aud).toBe('authenticated');
    expect(LOCAL_MODE_USER.role).toBe('authenticated');
  });

  it('has a valid UUID id — Dash0Provider identifies on it', () => {
    expect(LOCAL_MODE_USER.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
