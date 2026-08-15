import { defineConfig } from 'vitest/config';

/**
 * Vitest for the LIVE smoke suites in `supabase/tests/`.
 *
 * These suites are HTTP CLIENTS of the deployed Edge Functions — they speak
 * JSON-RPC to `functions/v1/mcp` and REST to `functions/v1/{memories,orgs}` —
 * so they belong to the `supabase` project, not to any Node package. They used
 * to live in `packages/mcp-server/`, which also carried an undeployed Node MCP
 * server; that server is gone (there was never a Fly.io deployment) and the
 * suites moved here, where the thing they actually test is defined.
 *
 * `include` is scoped to `tests/` on purpose: `supabase/functions/` is Deno
 * source with `npm:` specifiers and must never be swept into a Node test run.
 */
export default defineConfig({
  test: {
    globals: true,
    // In GitHub Actions, add the `github-actions` reporter alongside the
    // default one so each failing test emits a typed `::error file=…,line=…::`
    // annotation — surfaced at the top of the run and via the checks API, so a
    // failure is readable without expanding logs. No-op locally.
    reporters:
      process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      reportsDirectory: '../coverage/supabase',
      provider: 'v8',
    },
  },
});
