import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const REF = 'pqokxlhvnosogizsjztg';

/**
 * The warn-once guard is module-level state, so every test imports a FRESH
 * copy of the module via `vi.resetModules()` + a dynamic import.
 */
async function loadPattern(): Promise<() => RegExp> {
  vi.resetModules();
  const mod = await import('./otel-origins');
  return mod.supabaseOriginPattern;
}

describe('supabaseOriginPattern', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('with NEXT_PUBLIC_SUPABASE_PROJECT_REF set', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', REF);
    });

    it('matches the Edge Function path on supabase.co', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(
        supabaseOriginPattern().test(`https://${REF}.supabase.co/functions/v1/memories`),
      ).toBe(true);
    });

    it('matches the PostgREST path on supabase.co', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(supabaseOriginPattern().test(`https://${REF}.supabase.co/rest/v1/memories`)).toBe(
        true,
      );
    });

    it('matches the supabase.in domain', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(supabaseOriginPattern().test(`https://${REF}.supabase.in/functions/v1/mcp`)).toBe(
        true,
      );
    });

    it('does NOT match a different project ref', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(
        supabaseOriginPattern().test('https://someotherproject.supabase.co/rest/v1/memories'),
      ).toBe(false);
    });

    it('does NOT match a Supabase origin embedded in another host', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(supabaseOriginPattern().test(`https://evil.com/https://${REF}.supabase.co/x`)).toBe(
        false,
      );
    });

    it('does NOT match plain HTTP', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(supabaseOriginPattern().test(`http://${REF}.supabase.co/rest/v1/memories`)).toBe(
        false,
      );
    });

    it('does NOT match a lookalike TLD such as supabase.com', async () => {
      const supabaseOriginPattern = await loadPattern();
      expect(supabaseOriginPattern().test(`https://${REF}.supabase.com/rest/v1/memories`)).toBe(
        false,
      );
    });

    it('does not warn when the project ref is present', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const supabaseOriginPattern = await loadPattern();
      supabaseOriginPattern();
      supabaseOriginPattern();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('with NEXT_PUBLIC_SUPABASE_PROJECT_REF unset (documented fail-open)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', '');
    });

    it('matches ANY *.supabase.co host', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const supabaseOriginPattern = await loadPattern();
      const pattern = supabaseOriginPattern();
      expect(pattern.test('https://anyproject.supabase.co/rest/v1/memories')).toBe(true);
      expect(pattern.test(`https://${REF}.supabase.co/functions/v1/memories`)).toBe(true);
      expect(pattern.test('https://anyproject.supabase.in/functions/v1/mcp')).toBe(true);
      expect(warn).toHaveBeenCalled();
    });

    it('still does NOT match a nested host or plain HTTP', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const supabaseOriginPattern = await loadPattern();
      const pattern = supabaseOriginPattern();
      expect(pattern.test(`https://evil.com/https://${REF}.supabase.co/x`)).toBe(false);
      expect(pattern.test(`http://${REF}.supabase.co/rest/v1/memories`)).toBe(false);
    });

    it('warns exactly ONCE no matter how many times it is called', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const supabaseOriginPattern = await loadPattern();
      supabaseOriginPattern();
      supabaseOriginPattern();
      supabaseOriginPattern();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('NEXT_PUBLIC_SUPABASE_PROJECT_REF');
    });
  });
});
