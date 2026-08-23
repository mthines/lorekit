import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '@lorekit/schemas/tool-catalog';

/**
 * Well-formedness of the catalog's `surfaces` bindings.
 *
 * Scope is deliberately narrow: this asserts only what can be decided FROM THE
 * CATALOG. The cross-surface half — that the CLI's registry, its per-command
 * help, and its stdio dispatch agree with these bindings — lives in
 * `packages/cli/test/surface-parity.test.mjs`, because `mcp-core` has no
 * dependency on `packages/cli` and Nx therefore neither invalidates this
 * project's cache nor marks it affected when a CLI file changes. Guard-bites
 * proved it: perturbing the CLI registry left this suite GREEN on a cache hit,
 * and only `--skip-nx-cache` revealed the assertions had been correct. A gate
 * that does not run on the changes it polices reports safety it is not
 * providing, so each half lives with its inputs.
 *
 * What stays here is the part whose only input IS the catalog, which this
 * project does depend on.
 */

describe('every op declares its surfaces', () => {
  it('carries a binding with a handler name', () => {
    // Anti-vacuity first: an empty catalog would satisfy every loop below.
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(15);

    for (const tool of MCP_TOOLS) {
      expect(tool.surfaces, `${tool.name} has no surfaces binding`).toBeDefined();
      // A string, never a reference — this module is zero-import, so naming the
      // symbol is all it can do. The generated dispatch module resolves it.
      expect(typeof tool.surfaces.handler, `${tool.name}.handler`).toBe('string');
      expect(tool.surfaces.handler.length, `${tool.name}.handler is empty`).toBeGreaterThan(0);
    }
  });

  it('gives every handler a distinct name', () => {
    // Two ops sharing a handler would mean one of them dispatches the other's
    // implementation — silently, since both names resolve.
    const handlers = MCP_TOOLS.map((t) => t.surfaces.handler);
    expect(new Set(handlers).size).toBe(handlers.length);
  });

  it('names a CLI command or states why there is none, never both and never neither', () => {
    for (const tool of MCP_TOOLS) {
      const { cli, cliExempt } = tool.surfaces;
      if (cli) {
        expect(cliExempt, `${tool.name} names a CLI command AND an exemption`).toBeUndefined();
      } else {
        expect(cliExempt, `${tool.name} has no CLI command and no cliExempt reason`).toBeTruthy();
      }
    }
  });

  it('gives every declared exemption a non-empty reason', () => {
    // An exemption is only worth having if it says something. `cliExempt: ''`
    // would satisfy the check above while explaining nothing to the next reader.
    for (const tool of MCP_TOOLS) {
      for (const field of ['cliExempt', 'localMcpExempt'] as const) {
        const reason = tool.surfaces[field];
        if (reason === undefined) continue;
        expect(reason.trim().length, `${tool.name}.${field} is blank`).toBeGreaterThan(10);
      }
    }
  });

  it('pins which ops are exempt from the CLI', () => {
    // Named rather than counted, so adding a command silently cannot leave its
    // exemption behind and an exemption cannot appear for an op that has one.
    const exempt = MCP_TOOLS.filter((t) => t.surfaces.cliExempt).map((t) => t.name).sort();
    expect(exempt).toEqual([
      'memory.list_archived',
      'org.create',
      'org.delete',
      'org.list',
      'org.rename',
    ]);
  });

  it('pins which ops the local stdio server does not back', () => {
    const exempt = MCP_TOOLS.filter((t) => t.surfaces.localMcpExempt).map((t) => t.name).sort();
    expect(exempt).toEqual([
      'memory.list_archived',
      'memory.purge',
      'memory.purge_expired',
    ]);
  });

  it('marks every op as MCP-dispatched', () => {
    // True today and worth pinning: the catalog is the MCP tool list, so an op
    // with `mcp: false` would be advertised nowhere and belongs in the REST-only
    // decision instead of here.
    for (const tool of MCP_TOOLS) {
      expect(tool.surfaces.mcp, `${tool.name} is catalogued but not MCP-dispatched`).toBe(true);
    }
  });

  it('gives every op a representative REST route', () => {
    // Documentation of the binding, not a projection — the mapping is
    // many-to-one (see the `SurfaceBinding` docblock). Asserted as present
    // because an op reachable over REST with no route recorded is the thing that
    // makes the REST-only decision impossible to audit later.
    for (const tool of MCP_TOOLS) {
      expect(typeof tool.surfaces.rest, `${tool.name}.rest`).toBe('string');
      expect(tool.surfaces.rest, `${tool.name}.rest is empty`).toBeTruthy();
    }
  });
});
