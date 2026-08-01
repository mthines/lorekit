import 'server-only';
import { highlightToHtml } from '@/lib/mdx/highlight-code';
import {
  GettingStartedContent,
  JSON_SNIPPET,
  YAML_SNIPPET,
  WRITE_SNIPPET,
  DOCTOR_CMD,
  type HighlightedSnippets,
} from './GettingStartedContent';

/**
 * Server-only wrapper that pre-highlights the tutorial's code with Shiki and
 * hands the HTML to {@link GettingStartedContent}. Used as the `/docs` MDX map's
 * `GettingStartedContent` renderer (that render runs on the server, so an async
 * component is fine), giving the Getting Started page the same highlighting as
 * fenced MDX blocks. The client dialog keeps rendering the plain
 * `GettingStartedContent` directly, which falls back to unhighlighted text.
 */
export async function GettingStartedContentServer({ isPublic }: { isPublic?: boolean }) {
  const [json, yaml, write, doctor] = await Promise.all([
    highlightToHtml(JSON_SNIPPET, 'json'),
    highlightToHtml(YAML_SNIPPET, 'yaml'),
    // `ts`, not `json`: WRITE_SNIPPET is an MCP tool call with unquoted keys, which
    // the JSON grammar tags as invalid and the theme then renders error-red.
    highlightToHtml(WRITE_SNIPPET, 'ts'),
    highlightToHtml(DOCTOR_CMD, 'bash'),
  ]);

  const snippets: Record<string, string> = {};
  if (json) snippets[JSON_SNIPPET] = json;
  if (yaml) snippets[YAML_SNIPPET] = yaml;

  const highlighted: HighlightedSnippets = {
    snippets,
    ...(write ? { write } : {}),
    ...(doctor ? { doctor } : {}),
  };

  return <GettingStartedContent isPublic={isPublic} highlighted={highlighted} />;
}
