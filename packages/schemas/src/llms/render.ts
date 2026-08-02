/**
 * Pure renderer for `packages/web/public/llms.txt`.
 *
 * `llms.txt` is the agent-readable mirror of the product surface. Roughly two
 * thirds of it — the MCP tool reference, the permission matrix, the docs index
 * — restates facts that already exist as typed values elsewhere, and used to
 * be retyped by hand with nothing checking the copy. This module derives those
 * sections instead:
 *
 *   MCP tools + permission matrix  ←  `../tool-catalog.ts`
 *   Docs index                     ←  the `packages/web/src/content/docs/*.mdx`
 *                                     frontmatter, read by `generate.ts`
 *
 * The remaining third is editorial — the quickstart, the local-mode recipe,
 * the scope-format explanation — and stays hand-written in `template.md`. No
 * schema can express "start here, do this first", and pretending otherwise
 * would trade a maintenance problem for a worse writing problem.
 *
 * Pure and dependency-free: `generate.ts` owns all I/O, and this file is unit
 * tested directly.
 */

import { MCP_TOOLS, type McpToolDoc, type JsonSchemaProperty } from '../tool-catalog.ts';

/** One entry in the generated docs index, read from an MDX file's frontmatter. */
export interface DocsIndexEntry {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
}

/** The placeholders `template.md` may contain. */
export const PLACEHOLDERS = ['MCP_TOOLS', 'PERMISSION_MATRIX', 'DOCS_INDEX'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const GENERATED_BANNER = `<!--
  GENERATED FILE — do not edit by hand.

  Editorial prose:  packages/schemas/src/llms/template.md
  Tool reference:   packages/schemas/src/tool-catalog.ts
  Docs index:       packages/web/src/content/docs/*.mdx (frontmatter)

  Regenerate:  pnpm nx generate:llms schemas
  Guarded by:  packages/schemas/src/llms/render.spec.ts
-->`;

/** Render one argument row for a tool's schema. */
function argumentRow(name: string, property: JsonSchemaProperty, required: boolean): string {
  const bits: string[] = [];
  if (property.description) bits.push(property.description);

  const constraints: string[] = [];
  if (property.type === 'array') constraints.push(`array of ${property.items?.type ?? 'string'}`);
  if (property.minimum !== undefined && property.maximum !== undefined) {
    constraints.push(`${property.minimum}–${property.maximum}`);
  } else if (property.minimum !== undefined) {
    constraints.push(`min ${property.minimum}`);
  } else if (property.maximum !== undefined) {
    constraints.push(`max ${property.maximum}`);
  }
  if (property.default !== undefined) constraints.push(`default \`${property.default}\``);
  if (property.format) constraints.push(property.format);
  if (constraints.length) bits.push(`_(${constraints.join(', ')})_`);

  return `| \`${name}\` | ${required ? '✓' : ''} | ${property.type} | ${bits.join(' ') || '—'} |`;
}

/** Render the full reference block for one tool. */
export function renderTool(tool: McpToolDoc): string {
  const lines: string[] = [`### ${tool.name}`, '', tool.description.replace(/\.?$/, '.'), ''];

  const properties = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const names = Object.keys(properties);

  if (names.length === 0) {
    lines.push('No arguments.', '');
  } else {
    lines.push('| Argument | Required | Type | Description |', '|----------|----------|------|-------------|');
    // Required arguments first, then optional — each group in declaration order.
    const ordered = [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))];
    for (const name of ordered) {
      lines.push(argumentRow(name, properties[name] as JsonSchemaProperty, required.has(name)));
    }
    lines.push('');
  }

  if (tool.permission) {
    lines.push(`Requires **${tool.permission}** permission.`, '');
  } else if (tool.auth === 'jwt-only') {
    lines.push('Requires a dashboard session JWT — not available via `lk_*` tokens.', '');
  }

  if (tool.returns) lines.push(`Returns: ${tool.returns}`, '');
  for (const note of tool.notes ?? []) lines.push(note, '');

  lines.push('---');
  return lines.join('\n');
}

/** Render the whole "MCP tools" body. */
export function renderTools(tools: readonly McpToolDoc[] = MCP_TOOLS): string {
  return tools.map(renderTool).join('\n\n');
}

/**
 * Render the token permission matrix.
 *
 * `lk_rw_` holds both permissions, so it is always ✓; `lk_ro_` and `lk_wo_`
 * follow the tool's family. `org.*` tools have no token tier at all and are
 * summarised in a footnote rather than given a misleading all-✗ row.
 */
export function renderPermissionMatrix(tools: readonly McpToolDoc[] = MCP_TOOLS): string {
  const gated = tools.filter((t) => t.permission !== null);
  const rows = gated.map((t) => {
    const read = t.permission === 'read' ? '✓' : '✗';
    const write = t.permission === 'write' ? '✓' : '✗';
    return `| \`${t.name}\` | ✓ | ${read} | ${write} |`;
  });

  return [
    '| Tool | lk_rw_ | lk_ro_ | lk_wo_ |',
    '|------|--------|--------|--------|',
    ...rows,
    '',
    '`org.*` tools require a Supabase user JWT (dashboard session) — not available via `lk_*` tokens.',
  ].join('\n');
}

/** Render the docs index from MDX frontmatter, ordered by the `order` field. */
export function renderDocsIndex(entries: readonly DocsIndexEntry[]): string {
  return [...entries]
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
    .map((e) => `- [${e.title}](https://lorekit.io/docs/${e.slug}) — ${e.description}`)
    .join('\n');
}

/**
 * Splice the generated sections into the editorial template.
 *
 * Throws on an unknown or unfilled placeholder rather than emitting a file
 * with a literal `{{TOKEN}}` in it — a silent hole here ships to agents.
 */
export function renderLlmsTxt(input: {
  readonly template: string;
  readonly docs: readonly DocsIndexEntry[];
  readonly tools?: readonly McpToolDoc[];
}): string {
  const tools = input.tools ?? MCP_TOOLS;
  const values: Record<Placeholder, string> = {
    MCP_TOOLS: renderTools(tools),
    PERMISSION_MATRIX: renderPermissionMatrix(tools),
    DOCS_INDEX: renderDocsIndex(input.docs),
  };

  const unknown = [...input.template.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1] as string)
    .filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length) {
    throw new Error(`Unknown placeholder(s) in template.md: ${[...new Set(unknown)].join(', ')}`);
  }

  let out = input.template;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${name}}}`, value);
  }

  return `${GENERATED_BANNER}\n\n${out.trimEnd()}\n`;
}
