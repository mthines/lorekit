import { expect, test } from '../support/fixtures';

/**
 * /api-docs is a route handler, not a page: it returns a Scalar HTML shell that
 * draws itself from a CDN script, so the browser view depends on the internet.
 * Assert what the SERVER returns instead — the shell, the OpenAPI spec, and the
 * Markdown edition agents read (the shell itself holds no content for them).
 */

test('the API reference shell is served', async ({ request }) => {
  const res = await request.get('/api-docs');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  expect(await res.text()).toContain('<title>LoreKit REST API</title>');
});

test('the API reference shell points agents at the Markdown edition', async ({ request }) => {
  const res = await request.get('/api-docs', { headers: { Accept: 'text/html' } });
  const html = await res.text();
  expect(html).toContain('<link rel="alternate" type="text/markdown" href="/api-docs.md"');
  expect(html).toMatch(/<noscript>[^<]*\/api-docs\.md[^<]*<\/noscript>/);
  expect(res.headers()['link']).toContain('</api-docs.md>; rel="alternate"; type="text/markdown"');
});

test('the OpenAPI spec is served as JSON', async ({ request }) => {
  const res = await request.get('/api-docs/spec');
  expect(res.status()).toBe(200);
  const spec = await res.json();
  expect(spec.info?.title).toBe('LoreKit REST API');
  expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
});

test('the API reference is served as Markdown at /api-docs.md', async ({ request }) => {
  const res = await request.get('/api-docs.md');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/markdown');
  const markdown = await res.text();
  expect(markdown).toMatch(/^# LoreKit REST API\n/);
  expect(markdown).toContain('\n### POST /memories\n');
  expect(markdown).toContain('Writes are real by default');
});

test('/api-docs returns the Markdown to a client that asks for it', async ({ request }) => {
  const res = await request.get('/api-docs', { headers: { Accept: 'text/markdown, text/html;q=0.9' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/markdown');
  expect(res.headers()['vary']).toMatch(/accept/i);
  // Never cacheable by a CDN: one that ignored `Vary` would serve it to browsers.
  expect(res.headers()['cache-control']).toContain('private');
  expect(res.headers()['cache-control']).not.toContain('s-maxage');
  expect(await res.text()).toMatch(/^# LoreKit REST API\n/);
});
