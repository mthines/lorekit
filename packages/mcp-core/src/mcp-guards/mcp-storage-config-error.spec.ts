import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan guard for the MCP transport (`supabase/functions/mcp/index.ts`),
 * the `mcp-preamble-usage.spec.ts` pattern: the Deno edge tree has no test
 * harness, so this property is asserted from here or not at all.
 *
 * `resolveStorageAdapter()` throws on a BYOD misconfiguration (a storage URL
 * without the service key). Called bare, the throw escapes `Deno.serve` and
 * every MCP call — `initialize` included — gets a bodyless `500 Internal Server
 * Error`; the reason reaches only the function log. docs/byod.md promises the
 * caller an error naming the missing variable, so the call must sit in a
 * try/catch that answers in-band with `jsonrpcError`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const source = readFileSync(path.join(repoRoot, 'supabase', 'functions', 'mcp', 'index.ts'), 'utf8');

const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];
const executable = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n');

describe('mcp transport — storage configuration errors', () => {
  it('resolves the storage adapter inside a try block', () => {
    expect(executable).toMatch(/try\s*\{\s*adapter\s*=\s*resolveStorageAdapter\(\);\s*\}\s*catch/);
  });

  it('answers a configuration error in-band with jsonrpcError, not a bare 500', () => {
    const catchBlock = /adapter\s*=\s*resolveStorageAdapter\(\);\s*\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(executable);
    expect(catchBlock?.[1]).toMatch(/return\s+jsonrpcError\(/);
  });

  it('never calls resolveStorageAdapter outside that guarded assignment', () => {
    const calls = executable.match(/resolveStorageAdapter\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
