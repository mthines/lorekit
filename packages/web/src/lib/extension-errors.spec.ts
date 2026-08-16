import { describe, it, expect } from 'vitest';

import {
  isExtensionOnlyStack,
  shouldIgnoreErrorFromExtension,
  stackOfUnknown,
} from './extension-errors';

/**
 * The two stacks below are copied verbatim from production `browser.error`
 * events on `service.name=web` (2026-08-16, `deployment.environment.name=production`).
 * They are the reason this module exists, so they are asserted as-is rather
 * than paraphrased into a tidier shape.
 */
const M_ID_EXTENSION_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'M_ID')",
  '    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)',
  '    at f (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:1442)',
].join('\n');

const METAMASK_STACK = [
  'i: Failed to connect to MetaMask',
  '    at Object.connect (chrome-extension://ejbalbakoplchlghecdalmeeeajnimhm/scripts/inpage.js:7:84179)',
].join('\n');

const FIRST_PARTY_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'M_ID')",
  '    at useLore (https://www.lorekit.io/_next/static/chunks/main-abc.js:1:761)',
  '    at renderWithHooks (https://www.lorekit.io/_next/static/chunks/framework-def.js:2:9001)',
].join('\n');

describe('isExtensionOnlyStack', () => {
  it('drops the production M_ID rejection — every frame is extension code', () => {
    expect(isExtensionOnlyStack(M_ID_EXTENSION_STACK)).toBe(true);
  });

  it('drops the production MetaMask inpage.js rejection', () => {
    expect(isExtensionOnlyStack(METAMASK_STACK)).toBe(true);
  });

  it('keeps a first-party stack carrying the SAME message', () => {
    // The whole point of filtering on the stack rather than the message: these
    // two errors are indistinguishable by message, and only one is ours.
    expect(isExtensionOnlyStack(FIRST_PARTY_STACK)).toBe(false);
  });

  it('keeps a mixed stack — an extension breaking OUR code is our bug', () => {
    const mixed = [
      'TypeError: listener is not a function',
      '    at inject (chrome-extension://abcdefghijklmnop/inject.js:1:10)',
      '    at onSubmit (https://www.lorekit.io/_next/static/chunks/page-xyz.js:3:220)',
    ].join('\n');
    expect(isExtensionOnlyStack(mixed)).toBe(false);
  });

  it('recognises Firefox and Safari extension schemes and frame syntax', () => {
    expect(
      isExtensionOnlyStack('Z@moz-extension://1f2e-3d4c/content.js:1:761\nf@moz-extension://1f2e-3d4c/content.js:1:1442'),
    ).toBe(true);
    expect(
      isExtensionOnlyStack('handler@safari-web-extension://8A9B/inject.js:2:33'),
    ).toBe(true);
    expect(isExtensionOnlyStack('at t (safari-extension://com.acme.ext/legacy.js:1:5)')).toBe(true);
    expect(isExtensionOnlyStack('at q (ms-browser-extension://9f/edge.js:1:5)')).toBe(true);
  });

  it('ignores frames that name no source instead of guessing their origin', () => {
    const withAnonymousFrames = [
      "TypeError: Cannot read properties of undefined (reading 'M_ID')",
      '    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)',
      '    at <anonymous>',
      '    at Array.forEach (native)',
    ].join('\n');
    expect(isExtensionOnlyStack(withAnonymousFrames)).toBe(true);
  });

  it('keeps an error whose stack has no source-bearing frame at all', () => {
    // Nothing here proves extension origin, so the error survives.
    expect(isExtensionOnlyStack('Error: boom\n    at <anonymous>')).toBe(false);
    expect(isExtensionOnlyStack('Error: boom')).toBe(false);
  });

  it('keeps an error with no stack', () => {
    expect(isExtensionOnlyStack(undefined)).toBe(false);
    expect(isExtensionOnlyStack(null)).toBe(false);
    expect(isExtensionOnlyStack('')).toBe(false);
  });

  it('does not treat Safari webkit-masked-url as proof of extension origin', () => {
    // Safari masks blob/worker scripts the page itself loaded with the same
    // scheme, so trusting it would drop real first-party errors.
    expect(isExtensionOnlyStack('at r (webkit-masked-url://hidden/:1:1)')).toBe(false);
  });

  it('does not let a message line quoting a URL vote on origin', () => {
    // `Failed to fetch https://…` is a message, not a frame: counting it as a
    // source-bearing frame would make it vote first-party and keep an error
    // whose only real frames are the extension's.
    const stack = [
      'TypeError: Failed to fetch https://api.lorekit.io/v1/lore',
      '    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)',
    ].join('\n');
    expect(isExtensionOnlyStack(stack)).toBe(true);
  });

  it('does not let a message line quoting an EXTENSION url vote either', () => {
    // The dangerous direction: the text mentions an extension, every real frame
    // is ours, so the error is ours and must survive.
    const stack = [
      'Error: Failed to load chrome-extension://abcdefghijklmnop/inject.js',
      '    at boot (https://www.lorekit.io/_next/static/chunks/main-abc.js:1:761)',
    ].join('\n');
    expect(isExtensionOnlyStack(stack)).toBe(false);
  });

  it('keeps an error whose only URL lives in the message line', () => {
    // No frame names a source, so nothing proves extension origin.
    expect(
      isExtensionOnlyStack('Error: Failed to load chrome-extension://abcdefghijklmnop/inject.js'),
    ).toBe(false);
  });

  it('is not fooled by an extension scheme appearing inside a page URL', () => {
    // A first-party frame stays first-party even when the URL mentions the
    // scheme in a query string.
    const stack = 'at report (https://www.lorekit.io/x.js?ref=chrome-extension://abc:1:1)';
    expect(isExtensionOnlyStack(stack)).toBe(false);
  });
});

describe('shouldIgnoreErrorFromExtension', () => {
  it('drops when the stack is extension-only', () => {
    expect(shouldIgnoreErrorFromExtension({ stack: M_ID_EXTENSION_STACK })).toBe(true);
  });

  it('keeps when the stack is ours', () => {
    expect(shouldIgnoreErrorFromExtension({ stack: FIRST_PARTY_STACK })).toBe(false);
  });

  it('lets the stack win over filename when both are present', () => {
    // A page-hosted script can raise an event whose filename is ours while the
    // throwing code is the extension's, and vice versa. The stack is the more
    // specific evidence, so it decides.
    expect(
      shouldIgnoreErrorFromExtension({
        stack: FIRST_PARTY_STACK,
        filename: 'chrome-extension://abcdefghijklmnop/inject.js',
      }),
    ).toBe(false);
  });

  it('falls back to filename for a thrown non-Error with no stack', () => {
    expect(
      shouldIgnoreErrorFromExtension({
        filename: 'chrome-extension://abcdefghijklmnop/inject.js',
      }),
    ).toBe(true);
    expect(
      shouldIgnoreErrorFromExtension({ filename: 'https://www.lorekit.io/app.js' }),
    ).toBe(false);
  });

  it('keeps anything it cannot attribute', () => {
    expect(shouldIgnoreErrorFromExtension(undefined)).toBe(false);
    expect(shouldIgnoreErrorFromExtension(null)).toBe(false);
    expect(shouldIgnoreErrorFromExtension({})).toBe(false);
  });
});

describe('stackOfUnknown', () => {
  it('reads the stack off an Error', () => {
    const error = new Error('boom');
    expect(stackOfUnknown(error)).toBe(error.stack);
  });

  it('reads the stack off an error-shaped plain object', () => {
    expect(stackOfUnknown({ stack: M_ID_EXTENSION_STACK })).toBe(M_ID_EXTENSION_STACK);
  });

  it('returns undefined for a rejection with a non-Error reason', () => {
    // `Promise.reject('boom')` and friends — nothing to read, so the caller
    // keeps the error.
    expect(stackOfUnknown('boom')).toBeUndefined();
    expect(stackOfUnknown(42)).toBeUndefined();
    expect(stackOfUnknown(null)).toBeUndefined();
    expect(stackOfUnknown(undefined)).toBeUndefined();
    expect(stackOfUnknown({ stack: 12345 })).toBeUndefined();
  });
});
