import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { classifyWebhookAction, prStatePurgeTarget } from './signal-filter.js';

/**
 * Mirror-parity guard for the Deno edge receiver.
 *
 * signal-filter.ts says its helpers "MUST be kept in sync" with the inlined
 * copies in supabase/functions/mcp/webhook.ts, because a Deno edge function is
 * self-contained and cannot import this package. That instruction is the only
 * thing holding the two copies together, and there are no Deno unit tests for
 * the edge webhook — CI exercises it through a real `supabase start`, which
 * catches a crash but not a semantic divergence.
 *
 * So this asserts the two sources agree, in the idiom of the sweeper parity
 * suite (smoke-cleanup.spec.ts): match the EXECUTABLE lines, never prose a
 * comment could satisfy, and derive the expected text from this side's source
 * rather than re-typing it — a guard that re-encodes what it checks only tests
 * itself.
 */

const edgeSource = readFileSync(
  fileURLToPath(new URL('../../../../supabase/functions/mcp/webhook.ts', import.meta.url)),
  'utf8',
);
const nodeSource = readFileSync(
  fileURLToPath(new URL('./signal-filter.ts', import.meta.url)),
  'utf8',
);

/** The one executable line that builds the purge target, from either source. */
function targetReturnLine(src: string): string | undefined {
  return /^\s*return \{ scope: `branch::.*`, key: `ci-state::pr-review-.*` \};$/m
    .exec(src)?.[0]
    .trim();
}

describe('edge webhook mirror parity — PURGE tier', () => {
  it('both sources build the purge target with the same template literals', () => {
    const node = targetReturnLine(nodeSource);
    const edge = targetReturnLine(edgeSource);
    // Not re-typed here: the expectation IS the other file's line. A scope or
    // key shape changed on one side alone fails this, which is the whole point —
    // pr-reviewer reads one set of coordinates, not two.
    expect(node, 'signal-filter.ts must build the target in one return statement').toBeDefined();
    expect(edge, 'the edge mirror must build the target in one return statement').toBeDefined();
    expect(edge).toBe(node);
  });

  it('the coordinates the mirror builds are the ones this side actually produces', () => {
    // Ties the source-text comparison above to real behaviour, so the pair
    // cannot agree on a shape that is wrong on both sides.
    const target = prStatePurgeTarget('pull_request', 'closed', {
      repository: { full_name: 'o/r' },
      pull_request: { number: 7, merged: true, head: { ref: 'b' } },
    });
    expect(target).toEqual({ scope: 'branch::o/r::b', key: 'ci-state::pr-review-7' });
    // And the mirror's literals, with the interpolations filled, produce it too.
    expect(targetReturnLine(edgeSource))
      .toBe('return { scope: `branch::${repo}::${head}`, key: `ci-state::pr-review-${num}` };');
  });

  it('both classifiers route pull_request closed to PURGE', () => {
    expect(classifyWebhookAction('pull_request', 'closed')).toBe('PURGE');
    // The executable ladder line, not the word PURGE in a doc comment.
    expect(edgeSource).toMatch(
      /^\s*if \(event === 'pull_request' && action === 'closed'\) return 'PURGE';$/m,
    );
  });

  it('both tier unions carry PURGE', () => {
    expect(edgeSource).toMatch(/type WebhookTier = 'WRITE' \| 'PURGE' \| 'SKIP';/);
    expect(nodeSource).toMatch(/type WebhookTier = 'WRITE' \| 'PURGE' \| 'SKIP';/);
  });

  it('the mirror gates on merged, so a plain close is not a purge', () => {
    // The guard, not the sentence about it. Without this line the edge would
    // archive state for a PR that can still be reopened and re-reviewed.
    expect(edgeSource).toMatch(/if \(pr\?\.\['merged'\] !== true\) return null;/);
  });

  it('the mirror soft-archives and never hard-deletes', () => {
    // `force: false` in the actual call. An irreversible delete driven by an
    // inbound webhook is the thing this must never become.
    expect(edgeSource).toMatch(/toolDelete\(db, \{ scope: target\.scope, key: target\.key, force: false \}/);
    expect(edgeSource).not.toMatch(/force: true/);
  });

  it('the mirror attributes the archive to a linked installation owner', () => {
    // A null user id would let memory_delete match every account's row at the
    // same (scope, key). Assert the lookup filters on `linked` and that the
    // resolved id is what reaches toolDelete.
    expect(edgeSource).toMatch(/\.eq\('status', 'linked'\)/);
    expect(edgeSource).toMatch(/toolDelete\([^)]*\}, userId, span\)/);
  });

  it('pull_request stays out of SUPPORTED_EVENTS', () => {
    // SUPPORTED_EVENTS gates the candidate-WRITE path. Adding pull_request there
    // would route a close into the comment pipeline as well as the purge branch.
    const set = /const SUPPORTED_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(edgeSource)?.[1] ?? '';
    expect(set).not.toMatch(/'pull_request'/);
    expect(set).toMatch(/'pull_request_review'/);
  });
});
