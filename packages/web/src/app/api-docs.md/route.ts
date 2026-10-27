import { apiDocsMarkdownResponse } from '@/lib/api-docs/rest-api';

/**
 * The REST API reference as one Markdown file, for AI agents and scripts.
 *
 * `/api-docs` (the Scalar page) is drawn by JavaScript, so a fetch of it holds
 * no content. This is the same OpenAPI document rendered server-side by
 * `@lorekit/schemas/openapi/markdown` — every operation, parameter, body,
 * response and a `curl` example — so the two can never disagree. The `.md`
 * suffix follows the llms.txt convention of a Markdown twin at the page's URL;
 * `/api-docs` also returns this body to a request that asks for
 * `Accept: text/markdown`. See `src/lib/api-docs/agent-docs.ts`.
 */
export function GET(request: Request) {
  return apiDocsMarkdownResponse(request.url);
}
