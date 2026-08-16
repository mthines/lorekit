/**
 * The two decoders must agree.
 *
 * `GET /memories` and `POST /memories/list` are one read over two transports,
 * and the failure mode worth testing is not that either decoder is wrong on its
 * own — it is that they drift, because a drift answers 200 with plausible rows
 * on both sides and nothing looks broken.
 */

import { describe, it, expect } from 'vitest';
import { dimensionsFromBody, dimensionsFromQuery, SCALAR_DIMENSIONS } from './dimensions.ts';

describe('dimensionsFromQuery / dimensionsFromBody', () => {
  it('produce the identical shape for equivalent input', () => {
    const fromQuery = dimensionsFromQuery({
      tags: 'auth,perf', tags_mode: 'all',
      host: 'reviewer,aw', host_mode: 'nin',
      origin_pr: '311,482',
    });
    const fromBody = dimensionsFromBody({
      tags: ['auth', 'perf'], tags_mode: 'all',
      host: ['reviewer', 'aw'], host_mode: 'nin',
      origin_pr: ['311', '482'],
    });
    expect(fromBody).toEqual(fromQuery);
  });

  it('default every mode the same way on both sides', () => {
    const q = dimensionsFromQuery({});
    const b = dimensionsFromBody({});
    expect(q).toEqual(b);
    expect(q.tags.mode).toBe('any');
    for (const name of SCALAR_DIMENSIONS) expect(q[name].mode).toBe('in');
  });

  it('represent an inactive dimension as empty values, never as absent', () => {
    const d = dimensionsFromQuery({});
    expect(d.host.values).toEqual([]);
    expect(d.tags.values).toEqual([]);
  });

  it('trim, drop empties and dedupe on both sides', () => {
    expect(dimensionsFromQuery({ host: ' aw , aw ,, reviewer ' }).host.values)
      .toEqual(['aw', 'reviewer']);
    expect(dimensionsFromBody({ host: [' aw ', 'aw', '', 'reviewer'] }).host.values)
      .toEqual(['aw', 'reviewer']);
  });

  it('drop a non-numeric pull request on both sides rather than failing', () => {
    expect(dimensionsFromQuery({ origin_pr: '482,oops' }).origin_pr.values).toEqual(['482']);
    expect(dimensionsFromBody({ origin_pr: ['482', 'oops'] }).origin_pr.values).toEqual(['482']);
  });

  it('drop an all-digit pull request too wide for int4, on both sides', () => {
    // Not a style rule: `lorekit_memory_facets` / `lorekit_memory_activity`
    // still cast under a bare digit regex and raise 22003 on this value, so
    // letting it through here is a 500. Dropping it at the shared decoder is
    // what keeps all three readers agreeing.
    expect(dimensionsFromQuery({ origin_pr: '482,99999999999' }).origin_pr.values).toEqual(['482']);
    expect(dimensionsFromBody({ origin_pr: ['482', '99999999999'] }).origin_pr.values).toEqual(['482']);
    // 2147483647 fits int4 but is ten digits, so the bound trades it away; no
    // repository has a PR number anywhere near it.
    expect(dimensionsFromBody({ origin_pr: ['999999999'] }).origin_pr.values).toEqual(['999999999']);
    // The zero-padded form still resolves — `007` has always meant PR 7.
    expect(dimensionsFromBody({ origin_pr: ['0000000007'] }).origin_pr.values).toEqual(['0000000007']);
  });

  it('differ in exactly one thing: only the query form splits on a comma', () => {
    // The body carries the value whole — the reason the transport exists.
    expect(dimensionsFromBody({ origin_branch: ['feat/a,b'] }).origin_branch.values)
      .toEqual(['feat/a,b']);
    expect(dimensionsFromQuery({ origin_branch: 'feat/a,b' }).origin_branch.values)
      .toEqual(['feat/a', 'b']);
  });

  it('tolerate a body field that is not an array', () => {
    // The handler validates first, but this decoder is total on purpose — the
    // edge tree has no test harness and a 500 here would be an outage.
    expect(dimensionsFromBody({ host: undefined }).host.values).toEqual([]);
    expect(dimensionsFromBody({ host: 'nope' as unknown as string[] }).host.values).toEqual([]);
  });
});
