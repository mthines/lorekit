import { expect, test } from '../support/fixtures';

/**
 * /api-docs is a route handler, not a page: it returns a Scalar HTML shell that
 * draws itself from a CDN script, so the browser view depends on the internet.
 * Assert what the SERVER returns instead — the shell and the OpenAPI spec.
 */

test('the API reference shell is served', async ({ request }) => {
  const res = await request.get('/api-docs');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  expect(await res.text()).toContain('<title>LoreKit REST API</title>');
});

test('the OpenAPI spec is served as JSON', async ({ request }) => {
  const res = await request.get('/api-docs/spec');
  expect(res.status()).toBe(200);
  const spec = await res.json();
  expect(spec.info?.title).toBe('LoreKit REST API');
  expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
});
