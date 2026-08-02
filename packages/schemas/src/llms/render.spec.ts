import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderTool,
  renderPermissionMatrix,
  renderDocsIndex,
  renderLlmsTxt,
  type DocsIndexEntry,
} from './render.ts';
import { buildLlmsTxt, parseFrontmatter, readDocsIndex, OUTPUT_PATH } from './generate.ts';
import { MCP_TOOLS, type McpToolDoc } from '../tool-catalog.ts';

const toolNamed = (name: string): McpToolDoc => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

describe('renderTool', () => {
  it('renders required arguments before optional ones', () => {
    const rows = renderTool(toolNamed('memory.write'))
      .split('\n')
      .filter((l) => l.startsWith('| `'));
    const firstOptional = rows.findIndex((r) => !r.includes(' ✓ |'));
    const lastRequired = rows.map((r) => r.includes(' ✓ |')).lastIndexOf(true);
    expect(lastRequired).toBeLessThan(firstOptional);
  });

  it('surfaces numeric bounds and defaults as constraints', () => {
    const out = renderTool(toolNamed('memory.purge'));
    expect(out).toContain('1–365');
    expect(out).toContain('default `30`');
  });

  it('states the permission a tool requires', () => {
    expect(renderTool(toolNamed('memory.read'))).toContain('Requires **read** permission.');
    expect(renderTool(toolNamed('memory.write'))).toContain('Requires **write** permission.');
  });

  it('flags jwt-only tools instead of claiming a token permission', () => {
    const out = renderTool(toolNamed('org.create'));
    expect(out).toContain('dashboard session JWT');
    expect(out).not.toContain('Requires **read**');
    expect(out).not.toContain('Requires **write**');
  });

  it('says so explicitly when a tool takes no arguments', () => {
    expect(renderTool(toolNamed('memory.purge_expired'))).toContain('No arguments.');
  });

  it('renders every catalog tool with a heading, and never leaves an empty cell row', () => {
    for (const tool of MCP_TOOLS) {
      const out = renderTool(tool);
      expect(out.startsWith(`### ${tool.name}`)).toBe(true);
      expect(out).not.toMatch(/\|\s*\|\s*\|\s*\|\s*\|/);
    }
  });
});

describe('renderPermissionMatrix', () => {
  it('gives lk_rw_ every gated tool, and splits ro/wo by family', () => {
    const matrix = renderPermissionMatrix();
    expect(matrix).toContain('| `memory.read` | ✓ | ✓ | ✗ |');
    expect(matrix).toContain('| `memory.write` | ✓ | ✗ | ✓ |');
  });

  it('omits org tools from the token matrix and footnotes them instead', () => {
    const matrix = renderPermissionMatrix();
    expect(matrix).not.toContain('`org.create`');
    expect(matrix).toContain('Supabase user JWT');
  });

  it('covers exactly the permission-gated tools', () => {
    const rows = renderPermissionMatrix().split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(MCP_TOOLS.filter((t) => t.permission !== null).length);
  });
});

describe('renderDocsIndex', () => {
  const entries: DocsIndexEntry[] = [
    { slug: 'b', title: 'Second', description: 'two', order: 2 },
    { slug: 'a', title: 'First', description: 'one', order: 1 },
  ];

  it('sorts by the frontmatter order field, not filename', () => {
    expect(renderDocsIndex(entries).split('\n')[0]).toContain('First');
  });

  it('links to the public docs URL for each slug', () => {
    expect(renderDocsIndex(entries)).toContain('(https://lorekit.io/docs/a)');
  });
});

describe('parseFrontmatter', () => {
  it('reads quoted and unquoted scalars', () => {
    const parsed = parseFrontmatter('---\ntitle: "A"\ndescription: B\norder: 3\n---\nbody');
    expect(parsed).toEqual({ title: 'A', description: 'B', order: '3' });
  });

  it('returns nothing for a file with no frontmatter', () => {
    expect(parseFrontmatter('# just a heading')).toEqual({});
  });
});

describe('renderLlmsTxt', () => {
  it('substitutes every placeholder', () => {
    const out = renderLlmsTxt({
      template: '# T\n\n{{PERMISSION_MATRIX}}\n{{MCP_TOOLS}}\n{{DOCS_INDEX}}\n',
      docs: [{ slug: 'a', title: 'A', description: 'd', order: 1 }],
    });
    expect(out).not.toMatch(/\{\{\w+\}\}/);
  });

  it('throws on an unknown placeholder rather than emitting a hole', () => {
    expect(() => renderLlmsTxt({ template: '{{NOPE}}', docs: [] })).toThrow(/NOPE/);
  });

  it('marks the output as generated', () => {
    const out = renderLlmsTxt({ template: '# T\n', docs: [] });
    expect(out).toContain('GENERATED FILE — do not edit by hand');
  });
});

describe('the committed llms.txt', () => {
  // The drift guard, mirroring edge-schema-parity.spec.ts: the repo's enforcement
  // idiom is a spec that recomputes the artifact, not a CI shell step.
  it('is exactly what the generator produces', () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(buildLlmsTxt());
  });

  it('documents every tool the catalog declares', () => {
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    for (const tool of MCP_TOOLS) expect(committed).toContain(`### ${tool.name}`);
  });

  it('indexes every published docs page', () => {
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    const docs = readDocsIndex();
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) expect(committed).toContain(`https://lorekit.io/docs/${doc.slug}`);
  });
});
