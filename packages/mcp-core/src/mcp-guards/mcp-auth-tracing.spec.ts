import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan guard for MCP auth-resolution telemetry
 * (`supabase/functions/mcp/auth.ts`) — the `tenant-scope-usage.spec.ts`
 * pattern, because the Deno edge tree has no test harness of its own.
 *
 * Three properties, none of which anything else in the suite can see:
 *
 * 1. AUTH RESOLUTION IS TIMED. Two of the three tiers make a network round-trip
 *    (an `api_tokens` select for `lk_*`, a GoTrue call for a JWT) and neither
 *    emitted a span, so the cost was unattributable wall clock inside the
 *    request span. Absent telemetry is not a wrong value, so no assertion
 *    anywhere else goes red when it disappears again.
 *
 * 2. THE SPAN IS ENDED ON EVERY PATH. The tier logic has six return paths. An
 *    `.end()` per path is one refactor away from being dropped on exactly the
 *    path that matters, so the guard requires the `finally` form.
 *
 * 3. THE TOKEN LOOKUP IS NOT TRACED THROUGH `createTracedClient`. That wrapper
 *    interpolates filter VALUES into the span name and `db.query.text`
 *    (`buildSql` over `eq()` arguments), and the filter on this query is the
 *    token hash — the stored credential. This is the security half of the
 *    guard: it must stay a hand-rolled span over the raw client.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/mcp-guards
const repoRoot = path.resolve(here, '../../../..');
const authPath = path.join(repoRoot, 'supabase', 'functions', 'mcp', 'auth.ts');
const source = readFileSync(authPath, 'utf8');

/** Executable lines only, so the explanatory comments cannot satisfy an assertion. */
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

const executable = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n');

describe('MCP auth resolution telemetry (supabase/functions/mcp/auth.ts)', () => {
  // Anti-vacuity: the assertions below describe this function and this query.
  it('still exports resolveAuth and still reads api_tokens by token_hash', () => {
    expect(executable).toContain('export async function resolveAuth(');
    expect(executable).toContain(".from('api_tokens')");
    expect(executable).toContain(".eq('token_hash', hash)");
  });

  it('opens a child span for the whole auth resolution', () => {
    expect(executable).toMatch(/child\(\s*'lorekit\.mcp\.auth'/);
  });

  it('ends the auth span in a finally, not per return path', () => {
    expect(executable).toMatch(/finally\s*\{\s*authSpan\?\.end\(\);\s*\}/);
  });

  it('marks the auth span errored when resolution throws, so the tree agrees with itself', () => {
    // Span.status defaults to 'ok', so a bare try/finally renders a failed
    // resolution as an OK parent above an errored child. traceRequest uses the
    // same catch-record-rethrow-finally form.
    expect(executable).toMatch(/catch\s*\(err\)\s*\{\s*authSpan\?\.error\([^;]*;\s*throw err;\s*\}/);
    expect(executable).not.toMatch(/authSpan\?\.error\([^;]*\.message/);
  });

  it('emits a CLIENT span for the api_tokens lookup', () => {
    expect(executable).toContain('SPAN_KIND_CLIENT');
    expect(executable).toMatch(/authSpan\?\.child\(\s*'SELECT[^']*api_tokens'/);
  });

  it('ends the api_tokens lookup span in a finally, so a rejected read still exports it', () => {
    // Span.end() is the only enqueue point into the export batch, so an .end()
    // sitting after the await is skipped when the read REJECTS — dropping the
    // child on exactly the failing case the span exists to make visible.
    expect(executable).toMatch(/finally\s*\{[^}]*lookupSpan\?\.setAttributes\([^)]*\)\.end\(\);\s*\}/);
  });

  it('records db.success so a failed lookup is distinguishable from a token miss', () => {
    // A DB error and a genuine miss both leave `data` null and both end in
    // `api_key_invalid`, so rows-0 on its own reports an outage as a bad key.
    expect(executable).toContain("'db.success': success");
    expect(executable).toMatch(/success\s*=\s*!result\.error;/);
  });

  it('puts a bounded value on the lookup span, never a free-form message — on EVERY arm', () => {
    // Same rule the JWT tier states explicitly, and the reason this query
    // avoids createTracedClient: nothing derived from this row reaches telemetry.
    // The rejection arm matters most — a Deno fetch failure renders the request
    // URL into its message, and that URL carries `token_hash=eq.<sha256>`.
    expect(executable).toMatch(/lookupSpan\?\.error\(`PostgrestError: \$\{result\.error\.code/);
    // `[^;]`, not `[^)]`: the leaking form is `error(\`${(err as Error).message}\`)`,
    // whose own parens would terminate a `[^)]*` scan before it reached `.message`.
    expect(executable).not.toMatch(/lookupSpan\?\.error\([^;]*\.message/);
  });

  it('never routes the token lookup through createTracedClient', () => {
    // createTracedClient interpolates `eq()` values into the span name and
    // db.query.text. The value here is the token hash, so tracing this query
    // that way would publish a credential into telemetry.
    expect(executable).not.toContain('createTracedClient');
  });

  it('keeps the auth outcome attributes on the caller-supplied span', () => {
    // mcp/index.ts passes the ROOT request span on purpose, so auth.type /
    // auth.outcome / auth.user_id stay queryable on the request itself. Adding
    // timing must not quietly relocate them onto the new child.
    expect(executable).toMatch(/span\?\.setAttributes\(\{\s*'auth\.outcome': 'api_key_valid'/);
    expect(executable).toMatch(/span\?\.setAttributes\(\{\s*'auth\.outcome': 'missing_token'/);
  });
});
