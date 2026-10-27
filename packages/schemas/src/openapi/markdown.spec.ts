import { describe, expect, it } from 'vitest';
import { generateSpec } from './spec.ts';
import { headingAnchor, renderOpenApiMarkdown, type OpenApiDocument } from './markdown.ts';

const LINKS = {
  htmlUrl: 'https://lorekit.test/api-docs',
  specUrl: 'https://lorekit.test/api-docs/spec',
  llmsTxtUrl: 'https://lorekit.test/llms.txt',
};

const BASE_URL = 'https://example.test/functions/v1';

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n### ${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const next = markdown.indexOf('\n### ', start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

// Runs the REAL document, so a route registered in spec.ts without being
// renderable here fails the build rather than vanishing from /api-docs.md.
describe('renderOpenApiMarkdown — the generated REST spec', () => {
  const spec = generateSpec(BASE_URL) as unknown as OpenApiDocument;
  const markdown = renderOpenApiMarkdown(spec, LINKS);

  it('documents every operation in the spec under its own heading', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        expect(markdown, `${method.toUpperCase()} ${path}`).toContain(`\n### ${method.toUpperCase()} ${path}\n`);
      }
    }
  });

  it('has no dangling in-page links', () => {
    const anchors = new Set(
      [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((m) => headingAnchor(m[1] as string)),
    );
    const targets = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(anchors, `#${target}`).toContain(target);
  });

  it('points at the base URL and the sibling formats', () => {
    expect(markdown).toContain(`\`${BASE_URL}\``);
    for (const url of Object.values(LINKS)) expect(markdown).toContain(url);
  });

  // The trap this guards: the spec's `default: true` is the console's pre-fill.
  // The server executes a write that omits the header, so an agent must never
  // read "default true" here.
  it('states the dry-run header defaults to a REAL write', () => {
    const row = markdown.split('\n').find((line) => line.startsWith('| `X-LoreKit-Dry-Run`'));
    expect(row).toBeDefined();
    expect(row).toContain('Default `false`');
    expect(row).not.toContain('Default `true`');
    expect(markdown).toContain('Writes are real by default');
  });

  it('writes shared headers once instead of in every operation table', () => {
    const rows = markdown.split('\n').filter((line) => line.startsWith('| `X-LoreKit-Client`'));
    expect(rows).toHaveLength(1);
    expect(section(markdown, 'POST /memories')).toContain('`X-LoreKit-Dry-Run`');
    expect(section(markdown, 'GET /memories')).not.toContain('`X-LoreKit-Dry-Run`');
    // A POST that only reads ignores the header, so it must not be offered one.
    expect(section(markdown, 'POST /memories/search')).not.toContain('`X-LoreKit-Dry-Run`');
  });

  it('links repeated shapes to one Schemas entry rather than inlining them', () => {
    expect(markdown.match(/^### Error$/gm)).toHaveLength(1);
    expect(markdown.match(/^### Memory$/gm)).toHaveLength(1);
    expect(section(markdown, 'GET /memories')).toContain('[MemoryPage](#memorypage)');
    // Smaller than even the minified JSON, despite adding prose and examples.
    expect(markdown.length).toBeLessThan(JSON.stringify(spec).length);
  });

  it('sends a bearer token in every example except the public routes', () => {
    expect(section(markdown, 'POST /memories')).toContain('-H "Authorization: Bearer $LOREKIT_TOKEN"');
    expect(section(markdown, 'GET /blog/likes')).not.toContain('Authorization');
    expect(section(markdown, 'GET /blog/likes')).toContain('None — public endpoint.');
  });

  it('builds a minimal body from the required fields', () => {
    expect(section(markdown, 'POST /memories')).toContain(`-d '{"scope":"<scope>","key":"<key>","value":"<value>"}'`);
  });

  // curl globs `{id}` into `id`, so an unedited copy would hit `/memories/id`
  // instead of failing loudly; only the curl URL changes, headings keep `{id}`.
  it('writes path parameters in curl URLs as <name> placeholders, never curl globs', () => {
    const curlLines = markdown.split('\n').filter((line) => line.startsWith('curl'));
    expect(curlLines.length).toBeGreaterThan(0);
    for (const line of curlLines) expect(line, line).not.toContain('{');
    expect(section(markdown, 'GET /memories/{id}')).toContain(`curl "${BASE_URL}/memories/<id>`);
  });

  it('is deterministic', () => {
    expect(renderOpenApiMarkdown(spec, LINKS)).toBe(markdown);
  });
});

describe('renderOpenApiMarkdown — rendering rules', () => {
  const doc: OpenApiDocument = {
    info: { title: 'Tiny API', version: '2.0.0', description: 'A tiny API.\n\nMore text.' },
    servers: [{ url: 'https://tiny.test' }],
    components: {
      schemas: {
        Thing: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    paths: {
      '/things/{id}': {
        put: {
          summary: 'Replace a thing',
          tags: ['Things'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'mode', in: 'query', required: true, schema: { type: 'string', enum: ['fast', 'safe'] } },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['note', 'meta'],
                  properties: {
                    note: { type: 'string', example: "it's here" },
                    count: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
                    meta: {
                      type: 'object',
                      required: ['owner'],
                      properties: { owner: { type: 'string', maxLength: 64 } },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Replaced',
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
            },
            '204': { description: 'Nothing to do' },
          },
        },
      },
    },
  };
  const markdown = renderOpenApiMarkdown(doc, LINKS);

  it('labels a nullable union and keeps the bound of its non-null branch', () => {
    expect(markdown).toContain('| `count` | no | integer or null | ≥ 0. |');
  });

  it('flattens a nested object into dotted rows', () => {
    expect(markdown).toContain('| `meta.owner` | yes | string | Length ≤ 64. |');
  });

  it('links an inline copy of a named component', () => {
    expect(markdown).toContain('`200` — Replaced → [Thing](#thing)');
    expect(markdown).toContain('### Thing');
  });

  it('describes a bodiless response', () => {
    expect(markdown).toContain('`204` — Nothing to do. No body.');
  });

  it('puts required query parameters in the example URL and shell-quotes the body', () => {
    expect(markdown).toContain('curl -X PUT "https://tiny.test/things/<id>?mode=<mode>"');
    expect(markdown).toContain('### PUT /things/{id}');
    expect(markdown).toContain(`-d '{"note":"it'\\''s here","meta":{"owner":"<owner>"}}'`);
  });

  it('uses the first line of the API description as the summary', () => {
    expect(markdown).toContain('> A tiny API. This is the Markdown edition');
    expect(markdown).not.toContain('More text.');
  });
});

describe('headingAnchor', () => {
  it.each([
    ['GET /memories/{id}', 'get-memoriesid'],
    ['POST /memories/purge-expired', 'post-memoriespurge-expired'],
    ['Common headers', 'common-headers'],
    ['MemoryPage', 'memorypage'],
  ])('%s → #%s', (heading, anchor) => {
    expect(headingAnchor(heading)).toBe(anchor);
  });
});
