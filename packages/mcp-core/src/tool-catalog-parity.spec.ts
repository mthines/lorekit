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

/** Tool names in a `const X_TOOLS = { ... }` dispatch map in the handler. */
function dispatchMapNames(mapName: string): string[] {
  const block = new RegExp(`const ${mapName} = \\{([\\s\\S]*?)\\n\\} as const;`).exec(handlerSource);
  if (!block) throw new Error(`dispatch map ${mapName} not found — has mcp-handler.ts been restructured?`);
  return [...(block[1] as string).matchAll(/'([a-z_]+\.[a-z_]+)'\s*:/g)].map((m) => m[1] as string);
}

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

describe('tool catalog ↔ mcp-handler dispatch maps', () => {
  const dispatchable = [...dispatchMapNames('MEMORY_TOOLS'), ...dispatchMapNames('ORG_TOOLS')];

  it('finds a non-trivial number of dispatchable tools', () => {
    // Anti-vacuity: a regex that silently matches nothing would pass every
    // assertion below.
    expect(dispatchable.length).toBeGreaterThanOrEqual(14);
  });

  it('catalogues every dispatchable tool', () => {
    expect([...dispatchable].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('routes org tools through the org dispatch map only', () => {
    const orgNames = dispatchMapNames('ORG_TOOLS').sort();
    const catalogued = MCP_TOOLS.filter((t) => t.permission === null).map((t) => t.name).sort();
    expect(orgNames).toEqual(catalogued);
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
