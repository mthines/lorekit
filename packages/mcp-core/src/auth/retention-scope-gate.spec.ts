import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: the api-token key-scope allowlist (00068) must gate EVERY
 * retention/groom operation on BOTH surfaces — MCP `policy.*`/`groom.*` and
 * REST `/policies` + `/groom`. v1 shipped these tools without this gate
 * entirely (see plan.md's struck Decision row); this is v2's recurrence
 * guard for the "half-restored predicate" failure mode a reviewer explicitly
 * flagged — fixing the gate on SOME ops/surfaces and not others.
 *
 * Same technique as `tenant-scope-usage.spec.ts`: source-scans the edge Deno
 * tree (vitest cannot import it — self-contained Deno, no import map) for the
 * SHAPE of each handler's gate, not merely a mention of the predicate
 * somewhere in the file. Removing any ONE gate below must turn this file RED.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (rel: string) => readFileSync(path.resolve(here, '../../../../supabase/functions', rel), 'utf8');

const toolsSource = edge('mcp/tools.ts');
const mcpHandlerSource = edge('mcp/mcp-handler.ts');
const policiesSource = edge('memories/handlers/policies.ts');
const groomSource = edge('memories/handlers/groom.ts');

/**
 * Slice a named function's body out of an edge source file. Handles both
 * `export async function NAME(` (the dispatched tool handlers) and the
 * unexported `async function NAME(` / `function NAME(` forms (internal
 * helpers like `resolveGroomRequest`/`assertScopeAllowed`/`findPolicyRow`).
 */
function extractFunctionBody(src: string, fnName: string): string {
  const candidates = [
    `export async function ${fnName}(`,
    `async function ${fnName}(`,
    `export function ${fnName}(`,
    `function ${fnName}(`,
  ];
  const signature = candidates.find((c) => src.includes(c));
  if (!signature) throw new Error(`function ${fnName} not found`);
  const start = src.indexOf(signature);
  const sigOpen = src.indexOf('(', start);
  let depthParen = 0;
  let paramsEnd = -1;
  for (let i = sigOpen; i < src.length; i++) {
    if (src[i] === '(') depthParen++;
    else if (src[i] === ')' && --depthParen === 0) {
      paramsEnd = i;
      break;
    }
  }
  if (paramsEnd === -1) throw new Error(`could not find end of params for ${fnName}`);
  // Skip the return-type annotation (e.g. `: Promise<GroomConditions | {
  // error: Response }>`), which can itself contain a brace-balanced object
  // type — a plain `indexOf('{', paramsEnd)` would stop on THAT brace, not
  // the function body's. Track angle-bracket depth instead: a `{` is only
  // the body's opening once the return type's generic has fully closed.
  let angleDepth = 0;
  let bodyStart = -1;
  for (let i = paramsEnd; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angleDepth++;
    else if (c === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (c === '{' && angleDepth === 0) { bodyStart = i; break; }
  }
  if (bodyStart === -1) throw new Error(`could not find body start for ${fnName}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`could not find end of function body for ${fnName}`);
}

describe('retention scope-gate guard (MCP tools.ts)', () => {
  it('imports the shared gate from the mirrored api-key module', () => {
    expect(toolsSource).toMatch(
      /import\s*\{[^}]*\bscopeAllowedByKey\b[^}]*\bnarrowByKeyScope\b[^}]*\bKeyScopeDeniedError\b[^}]*\}\s*from\s*['"]\.\.\/_shared\/schemas\/api-key\.(ts|js)['"]/,
    );
  });

  it('assertScopeAllowed throws KeyScopeDeniedError via the shared predicate', () => {
    const body = extractFunctionBody(toolsSource, 'assertScopeAllowed');
    expect(body).toContain('scopeAllowedByKey(');
    expect(body).toContain('new KeyScopeDeniedError(');
  });

  it('toolPolicyCreate gates its target scope', () => {
    const body = extractFunctionBody(toolsSource, 'toolPolicyCreate');
    expect(body).toMatch(/assertScopeAllowed\(\s*restriction\s*,\s*scope\s*\)/);
  });

  it('toolPolicyList narrows results to the key allowlist', () => {
    const body = extractFunctionBody(toolsSource, 'toolPolicyList');
    expect(body).toMatch(/narrowByKeyScope\(\s*restriction\?\.scopes\s*\?\?\s*\[\]/);
  });

  it.each(['toolPolicyUpdate', 'toolPolicyDelete'])(
    '%s pre-fetches the STORED scope and gates it before the mutation RPC',
    (fnName) => {
      const body = extractFunctionBody(toolsSource, fnName);
      const fetchAt = body.indexOf('findPolicyRow(');
      const gateAt = body.search(/assertScopeAllowed\(\s*restriction\s*,\s*existing\.scope\s*\)/);
      const rpcAt = body.search(/tracedDb\s*\n?\s*\.rpc\(\s*['"]lorekit_policy_(update|delete)['"]/);
      expect(fetchAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(-1);
      expect(rpcAt).toBeGreaterThan(-1);
      // Fail-closed ordering: fetch, then gate, then (only then) the mutation.
      expect(fetchAt).toBeLessThan(gateAt);
      expect(gateAt).toBeLessThan(rpcAt);
    },
  );

  it('findPolicyRow never leaks a policy outside the owner filter (single RPC, owner-scoped)', () => {
    const body = extractFunctionBody(toolsSource, 'findPolicyRow');
    expect(body).toContain("rpc('lorekit_policy_list', { p_user_id: userId })");
  });

  it('resolveGroomRequest gates the RESOLVED conditions.scope (covers inline scope AND a policy_id\'s stored scope)', () => {
    const body = extractFunctionBody(toolsSource, 'resolveGroomRequest');
    expect(body).toMatch(/assertScopeAllowed\(\s*restriction\s*,\s*conditions\.scope\s*\)/);
    // The gate must run AFTER resolution (both branches converge to one
    // conditions.scope) and BEFORE the function returns it to the caller,
    // which then calls the archive/preview RPC.
    const resolveAt = body.indexOf('resolveGroomConditions(');
    const gateAt = body.search(/assertScopeAllowed\(\s*restriction\s*,\s*conditions\.scope\s*\)/);
    const returnAt = body.lastIndexOf('return conditions;');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(returnAt);
  });

  it.each(['toolGroomPreview', 'toolGroomRun'])(
    '%s forwards the restriction into resolveGroomRequest (does not drop it at the call site)',
    (fnName) => {
      const body = extractFunctionBody(toolsSource, fnName);
      expect(body).toMatch(/resolveGroomRequest\(\s*db\s*,\s*params\s*,\s*userId\s*,\s*span\s*,\s*restriction\s*\)/);
    },
  );
});

describe('retention scope-gate guard (MCP dispatch — mcp-handler.ts)', () => {
  it('imports KeyScopeDeniedError and maps it to JSONRPC_FORBIDDEN', () => {
    expect(mcpHandlerSource).toMatch(
      /import\s*\{[^}]*\bKeyScopeDeniedError\b[^}]*\}\s*from\s*['"]\.\.\/_shared\/schemas\/api-key\.(ts|js)['"]/,
    );
    expect(mcpHandlerSource).toMatch(/instanceof\s+KeyScopeDeniedError/);
    expect(mcpHandlerSource).toMatch(/isKeyScopeDenied[\s\S]*?jsonrpcError\(\s*id,\s*JSONRPC_FORBIDDEN/);
  });

  it('never answers a KeyScopeDeniedError with the in-band isError shape', () => {
    // The denial must be checked (and returned) BEFORE the generic
    // isClientError-in-band branch, or a scope-restricted MCP client would
    // get a tool-originated-looking failure instead of a protocol denial.
    const forbiddenAt = mcpHandlerSource.search(/if\s*\(\s*isKeyScopeDenied\s*\)\s*\{[\s\S]*?jsonrpcError\(\s*id,\s*JSONRPC_FORBIDDEN/);
    const inBandAt = mcpHandlerSource.search(/if\s*\(\s*isClientError\s*\|\|\s*err instanceof LimitError\s*\)/);
    expect(forbiddenAt).toBeGreaterThan(-1);
    expect(inBandAt).toBeGreaterThan(-1);
    expect(forbiddenAt).toBeLessThan(inBandAt);
  });

  it('dispatches RETENTION_TOOLS with the calling key restriction as the 5th argument', () => {
    expect(mcpHandlerSource).toMatch(
      /RETENTION_TOOLS\[[\s\S]*?\]\([\s\S]*?analyticsUserId,\s*toolSpan,\s*keyRestriction\(auth\)\)/,
    );
  });
});

describe('retention scope-gate guard (REST /policies + /groom)', () => {
  it('policies.ts imports the shared gate', () => {
    expect(policiesSource).toMatch(
      /import\s*\{[^}]*\bscopeAllowedByKey\b[^}]*\bnarrowByKeyScope\b[^}]*\bkeyScopeDeniedMessage\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/_shared\/schemas\/api-key\.(ts|js)['"]/,
    );
  });

  it('handlePolicyCreate gates its target scope and returns forbidden', () => {
    const body = extractFunctionBody(policiesSource, 'handlePolicyCreate');
    expect(body).toMatch(/scopeAllowedByKey\(\s*restriction\.scopes\s*,\s*body\.scope\s*\)/);
    expect(body).toContain('return forbidden(keyScopeDeniedMessage(body.scope), cors)');
  });

  it('handlePolicyList narrows via narrowByKeyScope', () => {
    const body = extractFunctionBody(policiesSource, 'handlePolicyList');
    expect(body).toMatch(/narrowByKeyScope\(\s*restriction\?\.scopes\s*\?\?\s*\[\]/);
  });

  it.each(['handlePolicyUpdate', 'handlePolicyDelete'])(
    '%s pre-fetches the STORED scope and gates it before the mutation RPC',
    (fnName) => {
      const body = extractFunctionBody(policiesSource, fnName);
      const fetchAt = body.indexOf('findPolicyRow(');
      const gateAt = body.search(/scopeAllowedByKey\(\s*restriction\.scopes\s*,\s*existing\.scope\s*\)/);
      const forbiddenAt = body.indexOf('return forbidden(keyScopeDeniedMessage(existing.scope), cors)');
      const rpcAt = body.search(/\.rpc\(\s*['"]lorekit_policy_(update|delete)['"]/);
      expect(fetchAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(-1);
      expect(forbiddenAt).toBeGreaterThan(-1);
      expect(rpcAt).toBeGreaterThan(-1);
      expect(fetchAt).toBeLessThan(gateAt);
      expect(gateAt).toBeLessThan(rpcAt);
    },
  );

  it('groom.ts imports the shared gate', () => {
    expect(groomSource).toMatch(
      /import\s*\{[^}]*\bscopeAllowedByKey\b[^}]*\bkeyScopeDeniedMessage\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/_shared\/schemas\/api-key\.(ts|js)['"]/,
    );
  });

  it('resolveConditions gates the RESOLVED conditions.scope and returns forbidden', () => {
    const body = extractFunctionBody(groomSource, 'resolveConditions');
    expect(body).toMatch(/scopeAllowedByKey\(\s*restriction\.scopes\s*,\s*conditions\.scope\s*\)/);
    expect(body).toContain('return { error: forbidden(keyScopeDeniedMessage(conditions.scope), cors) }');
    const resolveAt = body.indexOf('resolveGroomConditions(');
    const gateAt = body.search(/scopeAllowedByKey\(\s*restriction\.scopes\s*,\s*conditions\.scope\s*\)/);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(gateAt);
  });

  it.each(['handleGroomPreview', 'handleGroomRun'])(
    '%s forwards auth + cors into resolveConditions (does not drop the gate\'s inputs)',
    (fnName) => {
      const body = extractFunctionBody(groomSource, fnName);
      expect(body).toMatch(/resolveConditions\(\s*db,\s*span,\s*userId,\s*v\.data as GroomRequestInput,\s*auth,\s*cors\s*\)/);
    },
  );
});
