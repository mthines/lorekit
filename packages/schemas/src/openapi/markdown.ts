/**
 * Render the REST API's OpenAPI document as ONE Markdown file for AI agents.
 *
 * `/api-docs` is a Scalar page: an empty `<div id="app">` that a CDN script
 * draws in the browser. An agent that fetches it — `curl`, a web-fetch tool,
 * an MCP client reading docs into context — gets a title and nothing else, and
 * the raw OpenAPI JSON beside it is ~170 KB minified because zod-to-openapi
 * inlines every schema (the error body alone is repeated over a hundred times). This
 * renderer is the readable middle: every operation with its parameters, body,
 * responses and a copy-paste `curl`, in one pass, with shared shapes written
 * once and linked.
 *
 * It derives everything from the same document Scalar renders, so the two
 * cannot disagree. The only editorial text is the short "Before you call"
 * preamble, which states facts the document holds but buries — and it reads
 * those facts (the auth scheme, the shared headers) out of the document too.
 *
 * Pure and dependency-free: the web app owns the I/O (`/api-docs.md`), and this
 * file is unit tested against the real `generateSpec()` output.
 */

/** The subset of JSON Schema (OpenAPI 3.1 dialect) the generated document uses. */
export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly format?: string;
  readonly default?: unknown;
  readonly example?: unknown;
  readonly description?: string;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie' | string;
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: JsonSchema;
  /** What the server does when the parameter is absent, where that differs from the console pre-fill in `schema.default` (see `X-LoreKit-Dry-Run` in `spec.ts`). */
  readonly 'x-server-default'?: unknown;
}

interface MediaType {
  readonly schema?: JsonSchema;
}

export interface OpenApiOperation {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly security?: ReadonlyArray<Readonly<Record<string, readonly unknown[]>>>;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly content?: Readonly<Record<string, MediaType>> };
  readonly responses?: Readonly<
    Record<string, { readonly description?: string; readonly content?: Readonly<Record<string, MediaType>> }>
  >;
}

export interface OpenApiDocument {
  readonly info: { readonly title: string; readonly version?: string; readonly description?: string };
  readonly servers?: ReadonlyArray<{ readonly url: string }>;
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, JsonSchema>>;
    readonly securitySchemes?: Readonly<Record<string, { readonly description?: string }>>;
  };
}

/** Absolute URLs of the sibling formats, so the file can point at them. */
export interface MarkdownLinks {
  /** The interactive (browser) reference, e.g. `https://lorekit.io/api-docs`. */
  readonly htmlUrl: string;
  /** The OpenAPI JSON, e.g. `https://lorekit.io/api-docs/spec`. */
  readonly specUrl: string;
  /** The product-wide agent guide, e.g. `https://lorekit.io/llms.txt`. */
  readonly llmsTxtUrl: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const JSON_MEDIA = 'application/json';

/** Deepest nesting a field table flattens into dotted rows before it says `object`. */
const MAX_FLATTEN_DEPTH = 4;

// ── Small text helpers ──────────────────────────────────────────────────────

/** One table cell: no line breaks, and a literal `|` cannot end the cell. */
function cell(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

function code(value: unknown): string {
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

/** GitHub-style heading anchor (lowercase, punctuation dropped, spaces to `-`), so index links resolve wherever the file is rendered. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Key-order-independent JSON, so two inlined copies of one shape compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationHeading(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

// ── Schema description ──────────────────────────────────────────────────────

/**
 * Per-render state: which named component each inlined shape is, and which of
 * them the output has linked to (only those get a "Schemas" entry).
 */
class SchemaContext {
  private readonly nameByShape = new Map<string, string>();
  readonly linked = new Set<string>();

  constructor(readonly components: Readonly<Record<string, JsonSchema>>) {
    for (const [name, schema] of Object.entries(components)) {
      const shape = canonicalJson(schema);
      // First registration wins, so a later alias never renames a shape.
      if (!this.nameByShape.has(shape)) this.nameByShape.set(shape, name);
    }
  }

  /** The component a schema IS — by `$ref`, or by being an identical inline copy. */
  componentName(schema: JsonSchema): string | undefined {
    if (schema.$ref) return refName(schema.$ref);
    // Only objects are worth naming: a bare `string` matching some
    // single-field component would be a confusing link, not a helpful one.
    if (!schema.properties) return undefined;
    return this.nameByShape.get(canonicalJson(schema));
  }

  link(name: string): string {
    this.linked.add(name);
    return `[${name}](#${headingAnchor(name)})`;
  }

  resolve(schema: JsonSchema): JsonSchema {
    if (!schema.$ref) return schema;
    return this.components[refName(schema.$ref)] ?? {};
  }
}

/** `#/components/schemas/Memory` → `Memory`. */
function refName(ref: string): string {
  return ref.split('/').pop() ?? '';
}

function isNullSchema(schema: JsonSchema): boolean {
  return schema.type === 'null';
}

/** The variants of a union, nulls removed, plus whether `null` was one of them. */
function unionVariants(schema: JsonSchema): { variants: readonly JsonSchema[]; nullable: boolean } | null {
  const union = schema.anyOf ?? schema.oneOf;
  if (!union) return null;
  return { variants: union.filter((v) => !isNullSchema(v)), nullable: union.some(isNullSchema) };
}

/** `T | null` read as `T`; any other schema unchanged. */
function nonNullVariant(schema: JsonSchema): JsonSchema {
  const union = unionVariants(schema);
  return union && union.variants.length === 1 ? (union.variants[0] as JsonSchema) : schema;
}

/** An empty-array default (`tags: []`) says nothing worth printing. */
function hasMeaningfulDefault(schema: JsonSchema): boolean {
  return schema.default !== undefined && !(Array.isArray(schema.default) && schema.default.length === 0);
}

/** A short type label: `string`, `integer or null`, `array of string`, a component link. */
function typeLabel(schema: JsonSchema, ctx: SchemaContext): string {
  const component = ctx.componentName(schema);
  if (component) return ctx.link(component);

  const union = unionVariants(schema);
  if (union) {
    const label = union.variants.map((v) => typeLabel(v, ctx)).join(' or ');
    return union.nullable ? `${label} or null` : label;
  }

  if (schema.allOf?.length === 1) return typeLabel(schema.allOf[0] as JsonSchema, ctx);

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nonNull = types.filter((t) => t !== 'null');
  const nullable = nonNull.length < types.length;
  let base = nonNull.join(' or ') || (schema.properties ? 'object' : schema.enum ? 'string' : 'any');

  if (base === 'array' && schema.items) base = `array of ${typeLabel(schema.items, ctx)}`;
  if (base === 'object' && !schema.properties && typeof schema.additionalProperties === 'object') {
    const valueType = typeLabel(schema.additionalProperties, ctx);
    base = valueType === 'any' ? 'object' : `object (map of ${valueType})`;
  }
  return nullable ? `${base} or null` : base;
}

/** `Range 1–100.`, `≥ 0.`, `Length ≤ 512.` — `label` is omitted for an open-ended number range. */
function rangeNote(min: number | undefined, max: number | undefined, label: string): string | null {
  const prefix = label ? `${label} ` : '';
  if (min !== undefined && max !== undefined) return `${label || 'Range'} ${min}–${max}.`;
  if (min !== undefined) return `${prefix}≥ ${min}.`;
  if (max !== undefined) return `${prefix}≤ ${max}.`;
  return null;
}

/** Constraint sentences for one schema: allowed values, bounds, format, default. */
function constraintNotes(schema: JsonSchema, serverDefault: { readonly value: unknown } | null): string[] {
  const notes: string[] = [];
  const scalar = nonNullVariant(schema);

  if (scalar.enum) notes.push(`One of ${scalar.enum.map(code).join(', ')}.`);
  if (scalar.const !== undefined) notes.push(`Always ${code(scalar.const)}.`);
  if (scalar.format) notes.push(`Format: ${scalar.format}.`);

  const numberRange = rangeNote(scalar.minimum, scalar.maximum, '');
  if (numberRange) notes.push(numberRange);
  if (scalar.exclusiveMinimum !== undefined) notes.push(`> ${scalar.exclusiveMinimum}.`);
  if (scalar.exclusiveMaximum !== undefined) notes.push(`< ${scalar.exclusiveMaximum}.`);

  // `minLength: 1` alone is zod's `.min(1)` — "must not be empty" says it plainly.
  const nonEmptyOnly = scalar.minLength === 1 && scalar.maxLength === undefined;
  const lengthRange = nonEmptyOnly ? 'Non-empty.' : rangeNote(scalar.minLength, scalar.maxLength, 'Length');
  if (lengthRange) notes.push(lengthRange);
  if (scalar.pattern) notes.push(`Pattern: ${code(scalar.pattern)}.`);

  if (scalar.minItems !== undefined || scalar.maxItems !== undefined) {
    const items = rangeNote(scalar.minItems, scalar.maxItems, 'Items');
    if (items) notes.push(items);
  }
  if (scalar.items) {
    const itemNotes = constraintNotes(scalar.items, null).filter((n) => !n.startsWith('Default'));
    if (itemNotes.length) notes.push(`Each item: ${itemNotes.join(' ')}`);
  }

  if (serverDefault) {
    notes.push(`Default ${code(serverDefault.value)}.`);
  } else if (hasMeaningfulDefault(schema)) {
    notes.push(`Default ${code(schema.default)}.`);
  }
  return notes;
}

function notesCell(description: string | undefined, notes: readonly string[]): string {
  const prose = description?.trim() ?? '';
  // A description that already says "One of `a`, `b`" needs no second copy.
  const fresh = notes.filter((note) => !prose.includes(note.replace(/\.$/, '')));
  return cell([prose, ...fresh].filter(Boolean).join(' ')) || '—';
}

interface FieldRow {
  readonly name: string;
  readonly required: boolean;
  readonly type: string;
  readonly notes: string;
}

/** Flatten an object schema into table rows: dotted rows for nested shapes (`org.slug`, `entries[].key`), a link for a named component. */
function fieldRows(schema: JsonSchema, ctx: SchemaContext, prefix = '', depth = 0): FieldRow[] {
  const resolved = ctx.resolve(schema);
  const required = new Set(resolved.required ?? []);
  const rows: FieldRow[] = [];

  for (const [name, raw] of Object.entries(resolved.properties ?? {})) {
    const field = ctx.resolve(raw);
    const path = `${prefix}${name}`;
    rows.push({
      name: path,
      required: required.has(name),
      type: typeLabel(raw, ctx),
      notes: notesCell(field.description, constraintNotes(field, null)),
    });

    if (depth + 1 >= MAX_FLATTEN_DEPTH || ctx.componentName(raw)) continue;
    const nested = nestedObject(field);
    if (nested && !ctx.componentName(nested.schema)) {
      rows.push(...fieldRows(nested.schema, ctx, `${path}${nested.suffix}.`, depth + 1));
    }
  }
  return rows;
}

/** The object a field contains, directly or as the element of an array. */
function nestedObject(field: JsonSchema): { schema: JsonSchema; suffix: string } | null {
  const single = nonNullVariant(field);
  if (single.properties) return { schema: single, suffix: '' };
  if (single.items?.properties) return { schema: single.items, suffix: '[]' };
  return null;
}

function fieldTable(rows: readonly FieldRow[]): string {
  if (rows.length === 0) return '_No fields._';
  return [
    '| Field | Required | Type | Notes |',
    '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.name}\` | ${r.required ? 'yes' : 'no'} | ${cell(r.type)} | ${r.notes} |`),
  ].join('\n');
}

// ── Examples ────────────────────────────────────────────────────────────────

/** A minimal example value — required fields only, real enum/default values, `<name>` placeholders otherwise — so a copied call sends only what it needs. */
function exampleValue(schema: JsonSchema, ctx: SchemaContext, name: string, depth = 0): unknown {
  const resolved = ctx.resolve(schema);
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.enum?.length) return resolved.enum[0];
  if (hasMeaningfulDefault(resolved)) return resolved.default;

  const union = unionVariants(resolved);
  if (union?.variants[0]) return exampleValue(union.variants[0], ctx, name, depth);

  const type = Array.isArray(resolved.type) ? resolved.type.find((t) => t !== 'null') : resolved.type;
  if (resolved.properties || type === 'object') {
    if (depth >= MAX_FLATTEN_DEPTH) return {};
    const out: Record<string, unknown> = {};
    for (const key of resolved.required ?? []) {
      const property = resolved.properties?.[key];
      if (property) out[key] = exampleValue(property, ctx, key, depth + 1);
    }
    return out;
  }
  switch (type) {
    case 'array':
      return resolved.items ? [exampleValue(resolved.items, ctx, name, depth + 1)] : [];
    case 'integer':
    case 'number':
      return resolved.minimum ?? (resolved.exclusiveMinimum !== undefined ? resolved.exclusiveMinimum + 1 : 1);
    case 'boolean':
      return true;
    default:
      return `<${name}>`;
  }
}

/** Single-quote a string for a POSIX shell. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function curlExample(method: string, path: string, op: OpenApiOperation, baseUrl: string, ctx: SchemaContext): string {
  const query = (op.parameters ?? [])
    .filter((p) => p.in === 'query' && p.required)
    .map((p) => `${encodeURIComponent(p.name)}=<${p.name}>`);
  const url = `${baseUrl}${path}${query.length ? `?${query.join('&')}` : ''}`;

  const lines = [`curl${method === 'get' ? '' : ` -X ${method.toUpperCase()}`} "${url}"`];
  if (!isPublic(op)) lines.push(`  -H "Authorization: Bearer $LOREKIT_TOKEN"`);

  const body = op.requestBody?.content?.[JSON_MEDIA]?.schema;
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d ${shellQuote(JSON.stringify(exampleValue(body, ctx, 'body')))}`);
  }
  return ['```bash', lines.join(' \\\n'), '```'].join('\n');
}

// ── Operations ──────────────────────────────────────────────────────────────

/** An explicit empty `security` array is how OpenAPI marks an open endpoint. */
function isPublic(op: OpenApiOperation): boolean {
  return Array.isArray(op.security) && op.security.length === 0;
}

interface OperationRef {
  readonly method: string;
  readonly path: string;
  readonly op: OpenApiOperation;
}

function listOperations(doc: OpenApiDocument): OperationRef[] {
  const out: OperationRef[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) out.push({ method, path, op });
    }
  }
  return out;
}

const UNTAGGED = 'Other';

function primaryTag(op: OpenApiOperation): string {
  return op.tags?.[0] ?? UNTAGGED;
}

/** Tags in order of first appearance, so the file follows the spec's own grouping. */
function tagOrder(ops: readonly OperationRef[]): string[] {
  const tags: string[] = [];
  for (const { op } of ops) {
    const tag = primaryTag(op);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Header parameters attached identically to more than one operation, documented once under "Common headers" instead of in every table. */
function commonHeaders(ops: readonly OperationRef[]): Map<string, { param: OpenApiParameter; ops: OperationRef[] }> {
  const byShape = new Map<string, { param: OpenApiParameter; ops: OperationRef[] }>();
  for (const ref of ops) {
    for (const param of ref.op.parameters ?? []) {
      if (param.in !== 'header') continue;
      const shape = canonicalJson(param);
      const entry = byShape.get(shape) ?? { param, ops: [] };
      entry.ops.push(ref);
      byShape.set(shape, entry);
    }
  }
  const common = new Map<string, { param: OpenApiParameter; ops: OperationRef[] }>();
  for (const entry of byShape.values()) {
    if (entry.ops.length > 1) common.set(entry.param.name, entry);
  }
  return common;
}

function serverDefaultOf(param: OpenApiParameter): { readonly value: unknown } | null {
  return 'x-server-default' in param ? { value: param['x-server-default'] } : null;
}

function parameterTable(params: readonly OpenApiParameter[], ctx: SchemaContext): string {
  return [
    '| Name | In | Required | Type | Notes |',
    '|---|---|---|---|---|',
    ...params.map((p) => {
      const schema = p.schema ?? {};
      const notes = notesCell(p.description ?? schema.description, constraintNotes(schema, serverDefaultOf(p)));
      return `| \`${p.name}\` | ${p.in} | ${p.required ? 'yes' : 'no'} | ${cell(typeLabel(schema, ctx))} | ${notes} |`;
    }),
  ].join('\n');
}

/** Indent a block so it renders inside the preceding list item. */
function indent(block: string): string {
  return block.replace(/^/gm, '  ');
}

function responseLines(op: OpenApiOperation, ctx: SchemaContext): string[] {
  const groups = new Map<string, { statuses: string[]; summary: string; table: string | null }>();

  for (const [status, response] of Object.entries(op.responses ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const schema = response.content?.[JSON_MEDIA]?.schema;
    const description = response.description?.trim() ?? '';
    const component = schema ? ctx.componentName(schema) : undefined;
    let summary: string;
    let table: string | null = null;

    if (!schema) {
      summary = `${description}. No body.`.replace(/^\. /, '');
    } else if (component) {
      summary = `${description} → ${ctx.link(component)}`.trim();
    } else {
      summary = `${description} → ${typeLabel(schema, ctx)}`.trim();
      if (ctx.resolve(schema).properties) table = fieldTable(fieldRows(schema, ctx));
    }

    // Statuses that render identically (most often 400/401/403 → Error) share a line.
    const key = `${summary}\u0000${table ?? ''}`;
    const group = groups.get(key) ?? { statuses: [], summary, table };
    group.statuses.push(status);
    groups.set(key, group);
  }

  const lines: string[] = [];
  for (const { statuses, summary, table } of groups.values()) {
    lines.push(`- ${statuses.map((s) => `\`${s}\``).join(', ')} — ${summary}`);
    if (table) lines.push('', indent(table), '');
  }
  return lines;
}

function renderOperation(
  { method, path, op }: OperationRef,
  ctx: SchemaContext,
  baseUrl: string,
  shared: ReadonlySet<string>,
): string {
  const out: string[] = [`### ${operationHeading(method, path)}`, ''];
  if (op.summary) out.push(`**${op.summary.replace(/\.?$/, '.')}**`, '');
  if (op.description) out.push(op.description.trim(), '');

  const sharedHere = (op.parameters ?? []).filter((p) => p.in === 'header' && shared.has(p.name)).map((p) => p.name);
  const auth = isPublic(op) ? 'None — public endpoint.' : 'Bearer token (`Authorization: Bearer <token>`).';
  out.push(`- **Auth:** ${auth}`);
  if (sharedHere.length) {
    out.push(`- **Common headers:** ${sharedHere.map((h) => `\`${h}\``).join(', ')} — see [Common headers](#common-headers).`);
  }
  out.push('');

  const params = (op.parameters ?? []).filter((p) => !(p.in === 'header' && shared.has(p.name)));
  if (params.length) out.push('**Parameters**', '', parameterTable(params, ctx), '');

  const body = op.requestBody?.content?.[JSON_MEDIA]?.schema;
  if (body) {
    const resolved = ctx.resolve(body);
    out.push('**Request body** (`application/json`)', '');
    out.push(resolved.properties ? fieldTable(fieldRows(body, ctx)) : `\`${typeLabel(body, ctx)}\``, '');
  }

  out.push('**Responses**', '', ...responseLines(op, ctx), '');
  out.push('**Example**', '', curlExample(method, path, op, baseUrl, ctx), '');
  return out.join('\n');
}

// ── Document ────────────────────────────────────────────────────────────────

function renderCommonHeaders(
  common: ReturnType<typeof commonHeaders>,
  total: number,
  ctx: SchemaContext,
): string {
  const rows = [...common.values()].map(({ param, ops }) => {
    const methods = [...new Set(ops.map((o) => o.method.toUpperCase()))];
    const sentOn = ops.length === total ? 'every operation' : `${ops.length} operations (${methods.join(', ')})`;
    const notes = notesCell(param.description, constraintNotes(param.schema ?? {}, serverDefaultOf(param)));
    return `| \`${param.name}\` | ${sentOn} | ${cell(typeLabel(param.schema ?? {}, ctx))} | ${notes} |`;
  });
  return ['| Header | Accepted on | Type | Notes |', '|---|---|---|---|', ...rows].join('\n');
}

function renderIndex(ops: readonly OperationRef[], tags: readonly string[]): string {
  const out: string[] = [];
  for (const tag of tags) {
    out.push(`### ${tag}`, '', '| Method | Path | Summary |', '|---|---|---|');
    for (const ref of ops.filter((o) => primaryTag(o.op) === tag)) {
      const anchor = headingAnchor(operationHeading(ref.method, ref.path));
      out.push(`| ${ref.method.toUpperCase()} | [\`${ref.path}\`](#${anchor}) | ${cell(ref.op.summary ?? '')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function renderSchemas(ctx: SchemaContext): string {
  const out: string[] = [];
  const written = new Set<string>();
  // Rendering one schema can link another (MemoryPage → Memory), so keep going
  // until a pass adds nothing new.
  for (let pending = [...ctx.linked]; pending.length; pending = [...ctx.linked].filter((n) => !written.has(n))) {
    for (const name of pending) {
      written.add(name);
      const schema = ctx.components[name];
      if (!schema) continue;
      out.push(`### ${name}`, '');
      if (schema.description) out.push(schema.description.trim(), '');
      out.push(fieldTable(fieldRows(schema, ctx)), '');
    }
  }
  return out.join('\n');
}

/** Render the whole document. Deterministic: the same spec gives the same bytes. */
export function renderOpenApiMarkdown(doc: OpenApiDocument, links: MarkdownLinks): string {
  const ctx = new SchemaContext(doc.components?.schemas ?? {});
  const baseUrl = doc.servers?.[0]?.url ?? '';
  const ops = listOperations(doc);
  const tags = tagOrder(ops);
  const common = commonHeaders(ops);
  const shared = new Set(common.keys());

  const authDescription = Object.values(doc.components?.securitySchemes ?? {})[0]?.description;
  const intro = (doc.info.description ?? '').split('\n')[0]?.trim();

  // Operations first: rendering them is what decides which schemas get linked.
  const sections = tags.map((tag) => {
    const body = ops
      .filter((o) => primaryTag(o.op) === tag)
      .map((ref) => renderOperation(ref, ctx, baseUrl, shared));
    return [`## ${tag}`, '', ...body].join('\n');
  });
  const errorLink = ctx.components['Error'] ? ctx.link('Error') : 'a JSON error object';
  const commonTable = renderCommonHeaders(common, ops.length, ctx);
  const schemas = renderSchemas(ctx);

  return [
    `# ${doc.info.title}`,
    '',
    `> ${intro ? `${intro} ` : ''}This is the Markdown edition of the REST reference, written for AI agents and scripts. ` +
      'It is generated from the same OpenAPI document as the interactive reference, so the two always agree.',
    '',
    `- **Base URL:** \`${baseUrl}\` — every path below is relative to it.`,
    `- **OpenAPI 3.1 JSON:** ${links.specUrl}`,
    `- **Interactive reference (browser):** ${links.htmlUrl}`,
    `- **MCP tools, scopes, filtering and limits:** ${links.llmsTxtUrl}`,
    `- **Version:** ${doc.info.version ?? 'unversioned'} · ${ops.length} operations`,
    '',
    '## Before you call',
    '',
    `1. **Authenticate.** Send \`Authorization: Bearer <token>\` on every request except the ones marked public. ${authDescription ?? ''}`.trim(),
    '2. **Writes are real by default.** A `POST`, `PATCH` or `DELETE` without `X-LoreKit-Dry-Run: true` changes data. ' +
      'Send that header to have the request validated and authorized without changing anything (see [Common headers](#common-headers)).',
    `3. **Errors.** A non-2xx response carries ${errorLink}. \`429\` means rate-limited; wait for the \`Retry-After\` header before retrying.`,
    '4. **JSON in, JSON out.** Send request bodies with `Content-Type: application/json`.',
    '',
    '## Common headers',
    '',
    commonTable,
    '',
    '## Endpoints',
    '',
    renderIndex(ops, tags),
    ...sections,
    '## Schemas',
    '',
    'Named shapes the endpoints above link to, written out once.',
    '',
    schemas,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}
