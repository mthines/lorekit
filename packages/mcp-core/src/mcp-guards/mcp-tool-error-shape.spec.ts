import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: a failure that ORIGINATED IN THE TOOL must come back inside the
 * RESULT with `isError: true`; a failure to DISPATCH must stay a JSON-RPC error.
 *
 * The MCP spec (quoted verbatim in `@modelcontextprotocol/sdk`'s
 * `CallToolResult`) draws the line and says why:
 *
 *   "Any errors that originate from the tool SHOULD be reported inside the
 *    result object, with `isError` set to true, _not_ as an MCP protocol-level
 *    error response. Otherwise, the LLM would not be able to see that an error
 *    occurred and self-correct.
 *    However, any errors in _finding_ the tool, an error indicating that the
 *    server does not support tool calls, or any other exceptional conditions,
 *    should be reported as an MCP error response."
 *
 * A protocol error is consumed by the client LIBRARY and may never reach the
 * model — mcp-remote surfaces it as a transport failure. So a memory-cap hit
 * used to tell the agent nothing it could act on, when archiving something is
 * exactly what it should do next.
 *
 * TWO DIRECTIONS, and both matter:
 *
 *  1. Tool-originated failures must NOT regress to `jsonrpcError`, or agents
 *     stop being able to self-correct.
 *  2. Auth-family and dispatch failures must NOT drift INTO `isError`. That is
 *     not a cosmetic preference: `mcp-authz-status.spec.ts` documents a ~30
 *     minute mcp-remote hang caused by getting the auth-error shape wrong, and
 *     an `isError` result for "your token is invalid" would read to every client
 *     as a successful call whose tool happened to complain — so a rotated token
 *     would look like a working connection.
 *
 * These scan the Deno edge source (which vitest cannot import) — the same
 * approach as `mcp-authz-status.spec.ts` and `tenant-scope-usage.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const handler = readFileSync(
  path.resolve(here, '../../../../supabase/functions/mcp/mcp-handler.ts'),
  'utf8',
);

/**
 * Comments stripped. Load-bearing here: the explanatory comment beside the
 * `isError` return QUOTES the spec, including the literal `isError: true`, so a
 * naive count of that string finds two sites and the "exactly one" assertion
 * fails against correct code. Assertions about what the code DOES must read
 * only code.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Slice a brace-delimited block starting at the first `{` at or after `from`. */
function blockAt(src: string, from: number, label: string): string {
  const start = src.indexOf('{', from);
  if (start === -1) throw new Error(`${label}: no block found`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${label}`);
}

/**
 * The `catch` around the TOOL DISPATCH — anchored on the classification it
 * computes, then walked BACK to its own `catch`.
 *
 * Not `indexOf('} catch (err) {')`: the first such block in this file is the
 * JSON-parse catch near the top, so that anchor silently pointed this whole
 * guard at the wrong 250 lines and every assertion failed for the wrong reason.
 */
const CLASSIFIER = 'const isClientError = err instanceof UserInputError';
const classifierAt = handler.indexOf(CLASSIFIER);
if (classifierAt === -1) throw new Error(`${CLASSIFIER} not found — this guard needs updating`);
const catchAt = handler.lastIndexOf('} catch (err) {', classifierAt);
const toolCatch = blockAt(handler, catchAt, 'the tool-dispatch catch block');

/** Everything before that catch: the pre-dispatch refusals. */
const preDispatch = codeOnly(handler.slice(0, catchAt));

describe('tool-originated failures use isError', () => {
  it('the catch block returns an isError RESULT, not a protocol error', () => {
    expect(toolCatch).toMatch(/isError:\s*true/);
  });

  it('it is reached through the already-computed client-error classification', () => {
    // Reusing `isClientError` rather than inventing a second classification is
    // what keeps the span status, the usage outcome and the wire shape agreeing
    // about what kind of failure this was.
    expect(toolCatch).toMatch(/if\s*\(\s*isClientError\s*\|\|\s*err instanceof LimitError\s*\)/);
  });

  it('a memory-cap hit is tool-originated, so it no longer uses code -32040', () => {
    // The cap is the motivating case: "cap reached, archive something" is
    // actionable by the agent, and a protocol error hid it.
    expect(handler).not.toMatch(/-32040/);
  });

  it('a genuine server fault stays a protocol error (the spec\'s "exceptional conditions")', () => {
    // A DB outage is not something the model can self-correct from, and a client
    // may legitimately retry it.
    expect(toolCatch).toMatch(/jsonrpcError\(id,\s*-32603/);
  });

  it('the isError text is the bare message, not the class-qualified span text', () => {
    // `msg` is `Name: message`, which is useful on a span and noise to a model.
    expect(toolCatch).toMatch(/text:\s*\(err as Error\)\.message/);
  });

  it('the usage outcome is still recorded as a failure', () => {
    // THE trap of this transport: the wire shape became a 200, so an outcome
    // derived from the status would now read `ok` and quietly corrupt the
    // analytics. It is set explicitly, and must stay that way.
    expect(toolCatch).toMatch(/outcome/);
    expect(toolCatch).toMatch(/cap_exceeded/);
  });

  it('the span is still marked, so error rates do not silently drop', () => {
    expect(toolCatch).toMatch(/clientError\(/);
    expect(toolCatch).toMatch(/\.error\(/);
  });
});

describe('dispatch and auth failures stay protocol errors', () => {
  it.each([
    ['a parse error', /-32700/],
    ['an unknown tool', /-32601,\s*`Unknown tool/],
    ['a token permission denial', /JSONRPC_FORBIDDEN/],
  ])('%s is a jsonrpcError, never an isError result', (_label, pattern) => {
    expect(preDispatch).toMatch(pattern);
  });

  it('an unknown METHOD is a protocol error', () => {
    // Registered after the dispatch block, so it is checked against the whole file.
    expect(handler).toMatch(/-32601,\s*`Method not found/);
  });

  it('no pre-dispatch refusal returns isError', () => {
    // The load-bearing half of direction 2. If an auth refusal ever became an
    // isError result, every client would read a rotated token as a working one.
    expect(preDispatch).not.toMatch(/isError/);
  });

  it('exactly ONE isError site exists in the CODE, so the line cannot blur', () => {
    expect(codeOnly(handler).match(/isError:\s*true/g) ?? []).toHaveLength(1);
  });
});
