import { apiDocsMarkdownResponse } from '@/lib/api-docs/rest-api';

/**
 * The REST reference as Markdown for agents — the Scalar page at `/api-docs` is empty without JavaScript, and `.md` follows the llms.txt "Markdown twin" convention.
 * @see src/lib/api-docs/agent-docs.ts
 */
export function GET(request: Request) {
  return apiDocsMarkdownResponse(request.url);
}
