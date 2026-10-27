import { generateSpec } from '@lorekit/schemas/openapi/spec';
import { renderOpenApiMarkdown, type OpenApiDocument } from '@lorekit/schemas/openapi/markdown';

import {
  API_DOCS_PATH,
  API_DOCS_SPEC_PATH,
  LLMS_TXT_PATH,
  agentDocsLinkHeader,
} from './agent-docs';

/**
 * This environment's REST API base — the Edge Functions root. Pinned into the
 * spec's `servers[0].url` (and so into every Markdown example), so docs served
 * from a preview point at the preview's API.
 */
const SUPABASE_URL =
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'https://pqokxlhvnosogizsjztg.supabase.co';
export const REST_API_BASE_URL = `${SUPABASE_URL}/functions/v1`;

/** The same edge-cache policy as the JSON spec: cheap to regenerate, rarely changes. */
export const API_DOCS_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60';

export function restApiSpec(): OpenApiDocument {
  return generateSpec(REST_API_BASE_URL) as unknown as OpenApiDocument;
}

/**
 * The REST reference as Markdown, with absolute links back to this origin so
 * an agent holding only the file can still reach the JSON and the guide.
 */
export function apiDocsMarkdownResponse(requestUrl: string, extraHeaders: Record<string, string> = {}): Response {
  const origin = new URL(requestUrl).origin;
  const markdown = renderOpenApiMarkdown(restApiSpec(), {
    htmlUrl: new URL(API_DOCS_PATH, origin).href,
    specUrl: new URL(API_DOCS_SPEC_PATH, origin).href,
    llmsTxtUrl: new URL(LLMS_TXT_PATH, origin).href,
  });
  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': API_DOCS_CACHE_CONTROL,
      Link: agentDocsLinkHeader(),
      ...extraHeaders,
    },
  });
}
