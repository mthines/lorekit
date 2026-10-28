/**
 * How agents find the REST reference in a form they can read.
 *
 * `/api-docs` is a Scalar page: the server sends an empty `<div id="app">` and
 * a CDN script draws everything in the browser. A web-fetch tool, `curl`, or an
 * MCP client reading docs into context gets the title and nothing else. So the
 * same reference is also served as Markdown at `/api-docs.md`, and three
 * signposts lead there:
 *
 *   1. Content negotiation — `GET /api-docs` with `Accept: text/markdown`
 *      returns the Markdown directly (see {@link prefersMarkdown}).
 *   2. A `Link` response header naming the Markdown (`alternate`) and the
 *      OpenAPI JSON (`service-desc`, RFC 8631) — {@link agentDocsLinkHeader}.
 *   3. In the HTML itself, `<link rel="alternate">` tags and a plain-text
 *      `<noscript>` note, for the fetchers that read the page and nothing else
 *      — {@link withAgentHints}.
 *
 * Pure string work, unit tested in `agent-docs.spec.ts`; the route handlers own
 * the I/O.
 */

export const API_DOCS_PATH = '/api-docs';
export const API_DOCS_MARKDOWN_PATH = '/api-docs.md';
export const API_DOCS_SPEC_PATH = '/api-docs/spec';
export const LLMS_TXT_PATH = '/llms.txt';

const MARKDOWN_TYPES = new Set(['text/markdown', 'text/x-markdown']);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** The highest `q` the Accept header gives any of `types` (0 when none is listed). */
function bestQuality(accept: string, types: ReadonlySet<string>): number {
  let best = 0;
  for (const part of accept.split(',')) {
    const [rawType, ...params] = part.split(';');
    const type = rawType?.trim().toLowerCase();
    if (!type || !types.has(type)) continue;
    // Parameter names are case-insensitive (RFC 9110 §5.6.6): `Q=0` refuses too.
    const qParam = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    if (Number.isFinite(q) && q > best) best = q;
  }
  return best;
}

/** Wants Markdown when it names a Markdown type at least as high as HTML — browsers never send one, so a tie goes to Markdown and wildcards never count. */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const markdown = bestQuality(accept, MARKDOWN_TYPES);
  return markdown > 0 && markdown >= bestQuality(accept, HTML_TYPES);
}

/** `Link` header value pointing machine readers at the readable formats. */
export function agentDocsLinkHeader(): string {
  return [
    `<${API_DOCS_MARKDOWN_PATH}>; rel="alternate"; type="text/markdown"`,
    `<${API_DOCS_SPEC_PATH}>; rel="service-desc"; type="application/json"`,
    `<${API_DOCS_PATH}>; rel="service-doc"; type="text/html"`,
  ].join(', ');
}

/**
 * Add agent signposts to Scalar's HTML shell; the `<noscript>` note is plain text because converters disagree on whether its content is markup.
 * @throws {Error} When the shell lacks `</head>` or `<body>`, so a Scalar template change fails loudly instead of silently dropping the signposts.
 */
export function withAgentHints(html: string, origin: string): string {
  const markdownUrl = new URL(API_DOCS_MARKDOWN_PATH, origin).href;
  const specUrl = new URL(API_DOCS_SPEC_PATH, origin).href;
  const llmsUrl = new URL(LLMS_TXT_PATH, origin).href;

  const head = [
    '<meta name="description" content="REST API reference for LoreKit — shared, persistent agent memory. Markdown edition for agents: /api-docs.md">',
    `<link rel="alternate" type="text/markdown" href="${API_DOCS_MARKDOWN_PATH}" title="LoreKit REST API (Markdown, for agents)">`,
    `<link rel="alternate" type="application/json" href="${API_DOCS_SPEC_PATH}" title="LoreKit REST API (OpenAPI 3.1)">`,
  ].join('\n    ');

  const note = [
    'LoreKit REST API reference.',
    'This page is drawn by JavaScript. AI agents and scripts: read the same reference as Markdown at',
    `${markdownUrl} (or request this URL with "Accept: text/markdown").`,
    `OpenAPI 3.1 JSON: ${specUrl}. MCP tools and the product guide: ${llmsUrl}.`,
  ].join(' ');

  if (!html.includes('</head>') || !/<body[^>]*>/.test(html)) {
    throw new Error('Scalar HTML shell changed: </head> or <body> not found, cannot add agent hints.');
  }
  return html
    .replace('</head>', `    ${head}\n  </head>`)
    .replace(/<body[^>]*>/, (body) => `${body}\n    <noscript>${note}</noscript>`);
}
