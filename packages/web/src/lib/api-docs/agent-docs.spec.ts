import { describe, expect, it } from 'vitest';

import { agentDocsLinkHeader, prefersMarkdown, withAgentHints } from './agent-docs';

describe('prefersMarkdown', () => {
  it.each([
    // Agents that ask for Markdown get it.
    ['text/markdown', true],
    ['text/x-markdown', true],
    ['text/markdown, text/html, */*', true],
    ['text/html;q=0.9, text/markdown', true],
    ['text/markdown;q=0.8, text/plain', true],
    // Browsers and generic clients keep the page.
    [null, false],
    ['', false],
    ['*/*', false],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', false],
    ['text/html, text/markdown;q=0.5', false],
    ['text/markdown;q=0', false],
    // Parameter names are case-insensitive, so an uppercase `Q` still refuses.
    ['text/markdown;Q=0', false],
    ['text/html, text/markdown;Q=0.5', false],
    ['application/json', false],
  ])('%j → %s', (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe('agentDocsLinkHeader', () => {
  it('names the Markdown twin and the OpenAPI description', () => {
    const header = agentDocsLinkHeader();
    expect(header).toContain('</api-docs.md>; rel="alternate"; type="text/markdown"');
    expect(header).toContain('</api-docs/spec>; rel="service-desc"');
  });
});

describe('withAgentHints', () => {
  const shell = [
    '<!doctype html>',
    '<html>',
    '  <head>',
    '    <title>LoreKit REST API</title>',
    '  </head>',
    '  <body>',
    '    <div id="app"></div>',
    '  </body>',
    '</html>',
  ].join('\n');
  const html = withAgentHints(shell, 'https://lorekit.test');

  it('adds alternate links to the head', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<link rel="alternate" type="text/markdown" href="/api-docs.md"');
    expect(head).toContain('<link rel="alternate" type="application/json" href="/api-docs/spec"');
    expect(head).toContain('<meta name="description"');
  });

  it('adds a plain-text noscript note with absolute URLs inside the body', () => {
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1];
    expect(noscript).toBeDefined();
    expect(noscript).toContain('https://lorekit.test/api-docs.md');
    expect(noscript).toContain('https://lorekit.test/api-docs/spec');
    expect(noscript).toContain('https://lorekit.test/llms.txt');
    // Plain text: converters that read <noscript> as raw text must not see tags.
    expect(noscript).not.toMatch(/[<>]/);
    expect(html.indexOf('<noscript>')).toBeGreaterThan(html.indexOf('<body>'));
  });

  it('leaves the rest of the shell untouched', () => {
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('<title>LoreKit REST API</title>');
  });

  it('fails loudly when the shell no longer has the tags it splices into', () => {
    expect(() => withAgentHints('<div id="app"></div>', 'https://lorekit.test')).toThrow(/Scalar HTML shell changed/);
  });
});
