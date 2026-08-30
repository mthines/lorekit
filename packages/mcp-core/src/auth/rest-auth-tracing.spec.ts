import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan guard for REST auth-resolution telemetry
 * (`supabase/functions/_shared/api/auth.ts`) — the `mcp-auth-tracing.spec.ts`
 * pattern's REST counterpart, because the Deno edge tree has no test harness
 * of its own.
 *
 * `resolveRestAuth`'s `lk_*` tier ran the `api_tokens` lookup on a raw
 * `svcClient()` call with no span of its own, while the MCP surface's
 * equivalent lookup (`mcp/auth.ts`) has carried a dedicated CLIENT span since
 * 2026-08-06. The JWT tier's `auth.getUser()` call got its own span in #592
 * (`fca5bb8f`), which fixed a p95 latency spike on that path
 * (`api — elevated p95 latency`, `dash0.issue.identifier`
 * 16742799362499951900) but left the `lk_*` tier's lookup as the one
 * remaining unattributed round-trip on this surface — the SAME check rule
 * refired on the api_key tier once traffic shifted onto it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/auth
const repoRoot = path.resolve(here, '../../../..');
const authPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api', 'auth.ts');
const source = readFileSync(authPath, 'utf8');

/** Executable lines only, so the explanatory comments cannot satisfy an assertion. */
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

const executable = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n');

describe('REST auth resolution telemetry (supabase/functions/_shared/api/auth.ts)', () => {
  // Anti-vacuity: the assertions below describe this function and this query.
  it('still exports resolveRestAuth and still reads api_tokens by token_hash', () => {
    expect(executable).toContain('export async function resolveRestAuth(');
    expect(executable).toContain(".from('api_tokens')");
    expect(executable).toContain(".eq('token_hash', hash)");
  });

  it('emits a CLIENT span for the api_tokens lookup', () => {
    expect(executable).toContain('SPAN_KIND_CLIENT');
    expect(executable).toMatch(/span\.child\(\s*'SELECT[^']*api_tokens'/);
  });

  it('ends the api_tokens lookup span in a finally, so a rejected read still exports it', () => {
    expect(executable).toMatch(/finally\s*\{[^}]*lookupSpan\.setAttributes\([^)]*\)\.end\(\);\s*\}/);
  });

  it('records db.success so a failed lookup is distinguishable from a token miss', () => {
    expect(executable).toContain("'db.success': success");
    expect(executable).toMatch(/success\s*=\s*!result\.error;/);
  });

  it('puts a bounded value on the lookup span, never a free-form message', () => {
    // The rejection arm matters most — a Deno fetch failure renders the
    // request URL into its message, and that URL carries the token hash.
    expect(executable).toMatch(/lookupSpan\.error\(`PostgrestError: \$\{result\.error\.code/);
    expect(executable).not.toMatch(/lookupSpan\.error\([^;]*\.message/);
  });

  it('never routes the token lookup through createTracedClient', () => {
    // createTracedClient interpolates `eq()` values into the span name and
    // db.query.text. The value here is the token hash, so tracing this query
    // that way would publish a credential into telemetry.
    expect(executable).not.toContain('createTracedClient');
  });

  it('still emits a CLIENT span for the GoTrue auth.getUser() call (the #592 fix)', () => {
    expect(executable).toMatch(/span\.child\(\s*'lorekit\.auth\.supabase_get_user'/);
  });
});
