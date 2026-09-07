import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  resolveMcpClient,
  mcpClientAttributes,
  MCP_CLIENT_IDS,
  MCP_CLIENT_SOURCES,
} from './mcp-client-attribute.js';

/**
 * The vocabulary this dimension is allowed to take, asserted as a literal SET
 * rather than derived from `MCP_CLIENT_IDS` — deriving it would make the guard
 * agree with whatever the module currently says, and the whole point is that
 * the value reaching an exporter is bounded and reviewed. Adding an id is
 * meant to fail here first.
 */
const ALLOWED_IDS: ReadonlySet<string> = new Set([
  'claude-code',
  'claude-desktop',
  'agent0',
  'cursor',
  'windsurf',
  'vscode',
  'cline',
  'continue',
  'zed',
  'lorekit-cli',
  'mcp-remote',
  'mcp-inspector',
  'other',
]);

describe('resolveMcpClient — clientInfo, the authoritative input', () => {
  it.each([
    ['Claude Code', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['claude_code', 'claude-code'],
    ['Claude Desktop', 'claude-desktop'],
    ['claude-ai', 'claude-desktop'],
    ['agent0', 'agent0'],
    ['Cursor', 'cursor'],
    ['Windsurf', 'windsurf'],
    ['Cline', 'cline'],
    ['Continue', 'continue'],
    ['Zed', 'zed'],
    ['lorekit', 'lorekit-cli'],
    ['mcp-remote', 'mcp-remote'],
    ['mcp-inspector', 'mcp-inspector'],
    ['modelcontextprotocol-inspector', 'mcp-inspector'],
    ['Visual Studio Code', 'vscode'],
    ['vscode', 'vscode'],
  ] as const)('maps clientInfo.name %s to %s', (name, expected) => {
    expect(resolveMcpClient({ clientInfo: { name } }).name).toBe(expected);
  });

  it('reports the source so a reader knows the fidelity', () => {
    expect(resolveMcpClient({ clientInfo: { name: 'Claude Code' } }).source).toBe('client_info');
  });

  it('buckets a client that named itself but is not catalogued as `other`', () => {
    // Rule 1: an unrecognised MCP client is a countable unknown, not a
    // dropped one — this is the bucket whose growth says "extend the list".
    const resolved = resolveMcpClient({ clientInfo: { name: 'SomeNewAgentHost' } });
    expect(resolved.name).toBe('other');
    expect(resolved.source).toBe('client_info');
  });

  it('never echoes the caller-supplied string into the dimension', () => {
    const hostile = 'a'.repeat(300);
    expect(resolveMcpClient({ clientInfo: { name: hostile } }).name).toBe('other');
  });

  it('takes precedence over User-Agent when both identify a client', () => {
    const resolved = resolveMcpClient({
      clientInfo: { name: 'Cursor' },
      userAgent: 'claude-code/1.2.3',
    });
    expect(resolved.name).toBe('cursor');
    expect(resolved.source).toBe('client_info');
  });

  it('falls through to User-Agent when clientInfo carries no usable name', () => {
    for (const clientInfo of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: null }]) {
      const resolved = resolveMcpClient({ clientInfo, userAgent: 'cursor/0.1' });
      expect(resolved.name).toBe('cursor');
      expect(resolved.source).toBe('user_agent');
    }
  });

  it('tolerates a clientInfo that is not an object at all', () => {
    // It comes straight off a parsed JSON body, before any schema looked at it.
    for (const clientInfo of [null, undefined, 'claude-code', 7, []]) {
      expect(() => resolveMcpClient({ clientInfo })).not.toThrow();
    }
  });
});

describe('resolveMcpClient — User-Agent, the best-effort per-request input', () => {
  it.each([
    ['claude-code/1.0.88 (external, cli)', 'claude-code'],
    ['Cursor/0.42.3', 'cursor'],
    ['mcp-remote/0.1.29', 'mcp-remote'],
  ] as const)('recognises %s as %s', (ua, expected) => {
    const resolved = resolveMcpClient({ userAgent: ua });
    expect(resolved.name).toBe(expected);
    expect(resolved.source).toBe('user_agent');
  });

  it('OMITS rather than bucketing an unrecognised User-Agent', () => {
    // Deliberately asymmetric with clientInfo: a bare runtime UA identifies
    // nothing, so calling it `other` would pollute the bucket that means "an
    // MCP client we have not catalogued".
    for (const ua of ['node', 'undici', 'Mozilla/5.0', '', '   ', null, undefined]) {
      expect(resolveMcpClient({ userAgent: ua }).name).toBeNull();
    }
  });

  it('never reports a version from a User-Agent', () => {
    // The version is the one pass-through value, so it is accepted only from
    // the client's own structured self-report.
    expect(resolveMcpClient({ userAgent: 'claude-code/1.0.88' }).version).toBeNull();
  });

  it('reports nothing at all when neither input identifies a caller', () => {
    expect(resolveMcpClient({})).toEqual({ name: null, source: null, version: null });
  });
});

describe('CLIENT_PATTERNS ordering — a longer pattern must not be shadowed', () => {
  // First match wins, so any pattern that is a PREFIX of another must come
  // after it. These are the live shadowing pairs; a re-ordering that breaks one
  // silently re-buckets a real client, which is what this pins.
  it.each([
    ['claude-code', 'claude-code'],
    ['claude-desktop', 'claude-desktop'],
    ['mcp-inspector', 'mcp-inspector'],
    ['modelcontextprotocol-inspector', 'mcp-inspector'],
    ['visual-studio-code', 'vscode'],
  ] as const)('%s is not shadowed by a shorter sibling pattern', (name, expected) => {
    expect(resolveMcpClient({ clientInfo: { name } }).name).toBe(expected);
  });

  it('pairs every substring-shadowing pattern in the right order', () => {
    // Derived rather than hand-listed: for each pattern, no EARLIER pattern may
    // be a substring of it, or the earlier one wins and the later is dead.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-client-attribute.ts'),
      'utf8',
    );
    const block = source.slice(source.indexOf('CLIENT_PATTERNS'), source.indexOf('function normalise'));
    const patterns = [...block.matchAll(/\['([a-z0-9-]+)', '[a-z0-9-]+'\]/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(10);
    for (let i = 0; i < patterns.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(
          patterns[i].includes(patterns[j]),
          `"${patterns[j]}" (position ${j}) shadows "${patterns[i]}" (position ${i}) — move the longer pattern first`,
        ).toBe(false);
      }
    }
  });
});

describe('version sanitisation', () => {
  it.each(['1.2.3', '0.1.29', '2026.9.7-beta.1', '1.0.0+build.5', 'v1'] as const)(
    'accepts the version-shaped %s',
    (version) => {
      expect(resolveMcpClient({ clientInfo: { name: 'agent0', version } }).version).toBe(version);
    },
  );

  it.each([
    ['a'.repeat(33), 'over the 32-char cap'],
    ['1.2.3 (nightly)', 'contains a space and parens'],
    ['"><script>', 'not version-shaped at all'],
    ['-1.2', 'does not start alphanumeric'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ] as const)('rejects %s (%s)', (version) => {
    expect(resolveMcpClient({ clientInfo: { name: 'agent0', version } }).version).toBeNull();
  });

  it('accepts a version at exactly the cap', () => {
    const version = '1'.repeat(32);
    expect(resolveMcpClient({ clientInfo: { name: 'agent0', version } }).version).toBe(version);
  });

  it('ignores a non-string version', () => {
    for (const version of [123, null, {}, ['1.0']]) {
      expect(resolveMcpClient({ clientInfo: { name: 'agent0', version } }).version).toBeNull();
    }
  });
});

describe('mcpClientAttributes — the span payload', () => {
  it('names the attributes under `lorekit.mcp.client.`, never at it', () => {
    // An attribute must not also be a namespace prefix of another attribute,
    // so there is no bare `lorekit.mcp.client`.
    const attrs = mcpClientAttributes(resolveMcpClient({ clientInfo: { name: 'Claude Code' } }));
    expect(attrs).toEqual({
      'lorekit.mcp.client.name': 'claude-code',
      'lorekit.mcp.client.source': 'client_info',
    });
    expect(Object.keys(attrs)).not.toContain('lorekit.mcp.client');
  });

  it('omits everything when nothing identified the caller (rule 2)', () => {
    // Rule 2: absence omits rather than inventing a placeholder that would
    // aggregate into the largest bucket of the dimension.
    expect(mcpClientAttributes(resolveMcpClient({}))).toEqual({});
    expect(mcpClientAttributes(resolveMcpClient({ userAgent: 'node' }))).toEqual({});
  });

  it('withholds the version unless the caller opts in', () => {
    const resolved = resolveMcpClient({ clientInfo: { name: 'agent0', version: '1.2.3' } });
    expect(mcpClientAttributes(resolved)['lorekit.mcp.client.version']).toBeUndefined();
    expect(mcpClientAttributes(resolved, { includeVersion: true })).toEqual({
      'lorekit.mcp.client.name': 'agent0',
      'lorekit.mcp.client.source': 'client_info',
      'lorekit.mcp.client.version': '1.2.3',
    });
  });

  it('adds no version key when opted in but none resolved', () => {
    const resolved = resolveMcpClient({ clientInfo: { name: 'agent0' } });
    expect(mcpClientAttributes(resolved, { includeVersion: true })).toEqual({
      'lorekit.mcp.client.name': 'agent0',
      'lorekit.mcp.client.source': 'client_info',
    });
  });
});

describe('the dimension stays bounded', () => {
  it('declares exactly the reviewed vocabulary', () => {
    expect(new Set(MCP_CLIENT_IDS)).toEqual(ALLOWED_IDS);
    expect(MCP_CLIENT_IDS).toHaveLength(ALLOWED_IDS.size);
  });

  it('declares exactly two provenance values', () => {
    expect([...MCP_CLIENT_SOURCES]).toEqual(['client_info', 'user_agent']);
  });

  it('never emits a name or source outside the vocabulary, for any input', () => {
    const inputs: Array<Parameters<typeof resolveMcpClient>[0]> = [
      {},
      { clientInfo: { name: 'Claude Code' } },
      { clientInfo: { name: 'totally-unknown-host' } },
      { clientInfo: { name: '💥 emoji host 💥' } },
      { clientInfo: { name: 'lorekit::cli' } },
      { clientInfo: 'not-an-object' },
      { userAgent: 'cursor/1' },
      { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
      { userAgent: '' },
    ];
    for (const input of inputs) {
      const { name, source } = resolveMcpClient(input);
      if (name !== null) expect(ALLOWED_IDS.has(name)).toBe(true);
      if (source !== null) expect(MCP_CLIENT_SOURCES).toContain(source);
      // `source` is null exactly when `name` is.
      expect(name === null).toBe(source === null);
    }
  });
});
