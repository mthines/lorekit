import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_TOOLS, MCP_TOOL_NAMES, toWireTool } from '@lorekit/schemas/tool-catalog';
import { READ_TOOLS, WRITE_TOOLS, toolRequires } from './permissions.js';

/**
 * The catalog (`packages/schemas/src/tool-catalog.ts`) is the ONE declaration of
 * every MCP tool: `tools/list` renders from it and so does the MCP section of
 * `llms.txt`. Two things it cannot enforce by construction, asserted here:
 *
 *   1. Its `permission` field agrees with `permissions.ts`, which is what the
 *      server actually gates on. `permissions.ts` cannot import the catalog —
 *      it is mirrored self-contained into the edge function and a relative
 *      import would break `edge-parity.spec.ts`'s byte-for-byte comparison —
 *      so the two are held together by assertion, exactly as the audit action
 *      vocabulary is by `audit-vocabulary.spec.ts`.
 *   2. Every catalogued tool is actually dispatchable, and every dispatchable
 *      tool is catalogued. A tool in one but not the other is either an
 *      advertised no-op or an undocumented capability.
 */

const repoRoot = join(import.meta.dirname, '../../..');
const handlerSource = readFileSync(join(repoRoot, 'supabase/functions/mcp/mcp-handler.ts'), 'utf8');

const toolsSource = readFileSync(join(repoRoot, 'supabase/functions/mcp/tools.ts'), 'utf8');
const generatedDispatch = readFileSync(join(repoRoot, 'supabase/functions/mcp/tool-dispatch.generated.ts'), 'utf8');

describe('tool catalog ↔ permissions.ts', () => {
  it('agrees on which tools require read', () => {
    const fromCatalog = MCP_TOOLS.filter((t) => t.permission === 'read').map((t) => t.name).sort();
    expect(fromCatalog).toEqual([...READ_TOOLS].sort());
  });

  it('agrees on which tools require write', () => {
    const fromCatalog = MCP_TOOLS.filter((t) => t.permission === 'write').map((t) => t.name).sort();
    expect(fromCatalog).toEqual([...WRITE_TOOLS].sort());
  });

  it('marks exactly the ungated tools as org tools', () => {
    for (const tool of MCP_TOOLS) {
      expect(toolRequires(tool.name)).toBe(tool.permission);
      if (tool.permission === null) expect(tool.auth).toBe('jwt-only');
    }
  });
});

describe('tool catalog ↔ the generated dispatch maps', () => {
  /**
   * These four replace a regex that scraped `const MEMORY_TOOLS = {…}` out of
   * `mcp-handler.ts` and compared its keys to the catalog. That check had a
   * real job while the maps were hand-written; now they are GENERATED from the
   * catalog, so re-deriving the same comparison in a spec would only confirm
   * the generator agrees with itself — the `mock-that-reimplements-the-thing-
   * under-test` shape. What is worth asserting instead is that the runtime
   * really consumes the generated module, that the generated module is fresh
   * (owned by `surface-generator.spec.ts`'s `--check`), and that the handler
   * names it binds actually exist.
   */
  it('makes the handler import its maps rather than declare them', () => {
    expect(handlerSource).toContain("from './tool-dispatch.generated.ts'");
    // The literals must not come back: a re-declared map is exactly the drift
    // the generated module exists to prevent.
    expect(handlerSource).not.toMatch(/const MEMORY_TOOLS = \{/);
    expect(handlerSource).not.toMatch(/const ORG_TOOLS = \{/);
  });

  it('type-checks the key set against the catalog rather than by scraping', () => {
    // This is the assertion that replaced the regex, and it is stronger: a
    // missing op fails because `Record` requires every key, an extra one fails
    // as an excess property. Both are compile errors, caught by the
    // `edge-typecheck` CI job.
    expect(generatedDispatch).toMatch(/satisfies Record<MemoryToolName, unknown>/);
    expect(generatedDispatch).toMatch(/satisfies Record<OrgToolName, unknown>/);
  });

  it('binds a handler that tools.ts actually exports', () => {
    // The names live in the catalog as strings, so nothing but this connects
    // them to real symbols until `deno check` runs. Cheap, and it fails in the
    // fast suite rather than only in the Deno job.
    for (const tool of MCP_TOOLS) {
      const handler = tool.surfaces.handler;
      expect(
        new RegExp(`export async function ${handler}\\b|export function ${handler}\\b`).test(toolsSource),
        `${tool.name} names handler "${handler}", which tools.ts does not export`,
      ).toBe(true);
    }
  });

  it('renders tools/list from the catalog rather than an inline literal', () => {
    expect(handlerSource).toContain('tools: wireTools()');
    expect(handlerSource).not.toMatch(/name: 'memory\.\w+',\s*\n\s*description:/);
  });
});

describe('wire projection', () => {
  it('exposes only name, description and inputSchema', () => {
    for (const tool of MCP_TOOLS) {
      expect(Object.keys(toWireTool(tool)).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('gives every tool a described, object-typed input schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(10);
      // Every declared required field must exist in properties — an MCP client
      // reading the schema otherwise sees a required argument it cannot name.
      for (const required of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties?.[required], `${tool.name}.${required}`).toBeDefined();
      }
    }
  });

  it('describes every property of every tool', () => {
    for (const tool of MCP_TOOLS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(property.description, `${tool.name}.${name} needs a description`).toBeTruthy();
      }
    }
  });
});
