import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MCP_TOOLS } from '@lorekit/schemas/tool-catalog';
import { CreateMemoryBodySchema } from '@lorekit/schemas';
import { EMBEDDING_DIMENSIONS } from './embedding.js';

/**
 * Wiring guard for BRING-YOUR-OWN EMBEDDING.
 *
 * Server-side embedding costs money per write, so `resolveEmbeddingConfig`
 * leaves it off and the hosted deployment keeps it off. The opt-in is that a
 * caller may compute a vector itself and send it with the write; the server
 * only stores it. Sending a vector IS the switch — there is no second flag.
 *
 * That design has three ways to break SILENTLY, and each one is a test here.
 *
 *   1. The `config.enabled` gate swallows a supplied vector. The gate exists to
 *      stop the server SPENDING; a vector the caller already paid for must not
 *      be subject to it, or the feature does nothing on precisely the
 *      deployments it was built for (no key configured).
 *   2. A malformed pair is validated too late. Storing the vector happens in a
 *      backgrounded task whose failures are swallowed by design, so a rejection
 *      after the write would look exactly like a successful opt-in.
 *   3. Only one surface gets it. Agents write through MCP, humans and the
 *      dashboard through REST; a feature wired into one of them is invisible to
 *      whichever half a given user is.
 *
 * Structural rather than behavioural for the same reason
 * `embed-write-authz.spec.ts` is: the edge modules cannot be imported into
 * vitest (Deno-specific imports, module-scope `Deno.env`), and the failure mode
 * is silence rather than an exception.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), 'utf8');

const embedOnWrite = read('supabase', 'functions', '_shared', 'embed-on-write.ts');
const restCreate = read('supabase', 'functions', 'memories', 'handlers', 'create.ts');
const mcpTools = read('supabase', 'functions', 'mcp', 'tools.ts');

/** Executable lines only — several docblocks here describe the shapes being banned. */
function executable(src: string): string {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');
}

describe('embed-on-write accepts a caller-supplied vector', () => {
  const code = executable(embedOnWrite);

  it('takes the supplied pair as a parameter', () => {
    expect(code).toMatch(/supplied\s*:\s*SuppliedEmbedding\s*\|\s*null/);
  });

  it('does not call a provider when the caller supplied one', () => {
    // The whole cost argument: a supplied vector must never turn into a billed
    // request. `embedTexts` is the only call that spends money.
    expect(
      /supplied\s*\?[\s\S]{0,120}?embedTexts\s*\(/.test(code),
      'The supplied vector must be used directly; embedTexts is the paid path and belongs in '
        + 'the else branch only.',
    ).toBe(true);
  });

  it('does not apply the config.enabled gate to a supplied vector', () => {
    // Regression shape: a bare `if (!config.enabled) return;` at the top of the
    // function, before the supplied branch. It reads as harmless and silently
    // disables the entire opt-in on every deployment without a provider key —
    // which is every deployment this feature exists for.
    const gate = /if\s*\(\s*!\s*config\.enabled\s*\)\s*return;?/g;
    const gates = [...code.matchAll(gate)];
    expect(gates, 'expected exactly one config.enabled early-return').toHaveLength(1);
    const before = code.slice(0, gates[0]!.index);
    expect(
      /if\s*\(\s*!\s*supplied\s*\)\s*\{/.test(before),
      'The config.enabled early-return must sit INSIDE the `if (!supplied)` branch. That flag '
        + 'guards SPENDING; a vector the caller computed costs this deployment nothing, so '
        + 'gating it there disables bring-your-own-embedding wherever no provider key is set.',
    ).toBe(true);
  });

  it('records which side produced the vector', () => {
    // Without it, "is anyone actually using this" is only answerable by
    // reconciling row counts against a provider bill.
    expect(code).toMatch(/lorekit\.embedding\.source/);
    expect(code).toMatch(/'client'/);
    expect(code).toMatch(/'provider'/);
  });

  it('stores a supplied vector through the same authorising RPC', () => {
    // A supplied vector gets no privileged path into the column: same 00062
    // authorisation, same org/personal capability check, same actor.
    expect(code).toMatch(/lorekit_memory_set_embedding/);
    expect(
      (code.match(/lorekit_memory_set_embedding/g) ?? []).length,
      'One write path, not two — a second call site is where the authorisation rules drift apart.',
    ).toBe(1);
  });

  it('attributes the row to the model that actually produced the vector', () => {
    // `config.model` names the model the SERVER would have used. Recording it
    // for a client's vector is a lie the schema cannot detect and a selective
    // re-embed would act on.
    expect(code).toMatch(/p_model:\s*model,/);
    expect(code).not.toMatch(/p_model:\s*config\.model/);
  });
});

describe.each([
  ['REST POST /memories', restCreate, /embedOnWrite\s*\([^;]*\bsupplied\b[^;]*\)/],
  ['MCP memory.write', mcpTools, /embedOnWrite\s*\([^;]*\bsupplied\b[^;]*\)/],
])('%s', (_name, src, passesSupplied) => {
  const code = executable(src);

  it('validates the supplied pair with the shared parser', () => {
    // One parser for both surfaces. Two would be two definitions of a valid
    // vector, and they would drift on the width first.
    expect(code).toMatch(/parseSuppliedEmbedding\s*\(/);
    expect(code).toMatch(/from\s*['"][^'"]*_shared\/embedding\.ts['"]/);
  });

  it('validates BEFORE the row is written, not after', () => {
    // The ordering IS the test. Storing the vector is backgrounded and its
    // failures are swallowed, so a pair rejected after the write is
    // indistinguishable from a successful opt-in for the caller.
    const parsedAt = code.indexOf('parseSuppliedEmbedding(');
    const wroteAt = code.search(/\.rpc\s*(?:<[^>]*>)?\s*\(\s*['"]memory_write['"]/);
    expect(parsedAt, 'parseSuppliedEmbedding not found').toBeGreaterThan(-1);
    expect(wroteAt, 'memory_write RPC call not found').toBeGreaterThan(-1);
    expect(
      parsedAt < wroteAt,
      'parseSuppliedEmbedding must run before the memory_write RPC so an invalid pair is a '
        + 'client error instead of a silently dropped embedding.',
    ).toBe(true);
  });

  it('turns a rejected pair into a client error, never a 500', () => {
    expect(code).toMatch(/instanceof\s+EmbeddingError/);
  });

  it('passes the parsed pair through to embedOnWrite', () => {
    expect(code).toMatch(passesSupplied);
  });
});

describe('the opt-in is reachable from both public contracts', () => {
  it('the write body schema carries both fields', () => {
    // zod strips unknown keys, so a field absent here never reaches a handler
    // no matter how well the handler is wired.
    const parsed = CreateMemoryBodySchema.parse({
      scope: 'global',
      key: 'k',
      value: 'v',
      embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01),
      embedding_model: 'text-embedding-3-small',
    });
    expect(parsed.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(parsed.embedding_model).toBe('text-embedding-3-small');
  });

  it('a write with neither field still parses', () => {
    const parsed = CreateMemoryBodySchema.parse({ scope: 'global', key: 'k', value: 'v' });
    expect(parsed.embedding).toBeUndefined();
    expect(parsed.embedding_model).toBeUndefined();
  });

  it('the MCP tool catalog documents both arguments and neither is required', () => {
    // The catalog IS the MCP `inputSchema` and the source of `llms.txt`: an
    // argument missing here is one no agent will ever discover.
    const write = MCP_TOOLS.find((t) => t.name === 'memory.write');
    expect(write?.inputSchema.properties?.['embedding']).toBeDefined();
    expect(write?.inputSchema.properties?.['embedding_model']).toBeDefined();
    expect(write?.inputSchema.required).not.toContain('embedding');
    expect(write?.inputSchema.required).not.toContain('embedding_model');
  });

  it('the catalog states the width, since nothing else in the contract does', () => {
    // The 1536 bound lives in mcp-core, which @lorekit/schemas cannot import
    // (the dependency runs the other way), so the JSON Schema cannot express it
    // as maxItems. The description is the only place a caller can read it.
    const write = MCP_TOOLS.find((t) => t.name === 'memory.write');
    const embedding = write?.inputSchema.properties?.['embedding'];
    expect(embedding?.description).toContain(String(EMBEDDING_DIMENSIONS));
  });
});
