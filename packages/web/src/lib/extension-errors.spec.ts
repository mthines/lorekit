import { describe, it, expect } from 'vitest';

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isExtensionOnlyStack,
  isMutedCrossOriginError,
  messageOfUnknown,
  namesBrowserInjectedGlobal,
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

  it('falls back to filename when the stack names no source at all', () => {
    // A stack of `at <anonymous>` frames proves nothing, so it must not
    // short-circuit the evidence the host DID give us.
    expect(
      shouldIgnoreErrorFromExtension({
        stack: 'Error: boom\n    at <anonymous>\n    at Array.forEach (native)',
        filename: 'chrome-extension://abcdefghijklmnop/inject.js',
      }),
    ).toBe(true);
    expect(
      shouldIgnoreErrorFromExtension({
        stack: 'Error: boom\n    at <anonymous>',
        filename: 'https://www.lorekit.io/app.js',
      }),
    ).toBe(false);
  });

  it('still keeps a frameless stack when filename names no extension either', () => {
    expect(shouldIgnoreErrorFromExtension({ stack: 'Error: boom\n    at <anonymous>' })).toBe(
      false,
    );
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

/**
 * Copied verbatim from production `browser.error` events on `service.name=web`
 * (2026-11-08). Brave and Chrome on iOS evaluate their injected scripts as the
 * page's own, so the stack's only frame is the page URL — it reads as ours.
 */
const BRAVE_IOS_ETHEREUM = {
  message: "TypeError: undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
  stack: 'global code@https://www.lorekit.io/blog/open-agent-memory-format:1:16',
  filename: 'https://www.lorekit.io/blog/open-agent-memory-format',
};

const CHROME_IOS_GCRWEB = {
  message: "ReferenceError: Can't find variable: __gCrWeb",
  stack: 'global code@https://www.lorekit.io/blog/open-agent-memory-format:1:9',
  filename: 'https://www.lorekit.io/blog/open-agent-memory-format',
};

describe('namesBrowserInjectedGlobal', () => {
  it('matches the production Brave and Chrome iOS messages', () => {
    expect(namesBrowserInjectedGlobal(BRAVE_IOS_ETHEREUM.message)).toBe(true);
    expect(namesBrowserInjectedGlobal(CHROME_IOS_GCRWEB.message)).toBe(true);
    expect(namesBrowserInjectedGlobal("TypeError: window.__firefox__ is undefined")).toBe(true);
  });

  it('matches only whole identifiers', () => {
    expect(namesBrowserInjectedGlobal("Cannot read properties of undefined (reading 'ethereumAddress')")).toBe(false);
    expect(namesBrowserInjectedGlobal('my__gCrWebShim is not defined')).toBe(false);
    expect(namesBrowserInjectedGlobal('$ethereum is not defined')).toBe(false);
  });

  it('ignores a missing message', () => {
    expect(namesBrowserInjectedGlobal(undefined)).toBe(false);
    expect(namesBrowserInjectedGlobal(null)).toBe(false);
  });
});

describe('isMutedCrossOriginError', () => {
  it("matches the browser's muted error: Script error. with no stack and no filename", () => {
    expect(isMutedCrossOriginError({ message: 'Script error.', filename: '' })).toBe(true);
    expect(isMutedCrossOriginError({ message: 'Script error' })).toBe(true);
  });

  it('keeps a Script error. that still carries a stack or a script URL', () => {
    expect(isMutedCrossOriginError({ message: 'Script error.', stack: FIRST_PARTY_STACK })).toBe(false);
    expect(
      isMutedCrossOriginError({
        message: 'Script error.',
        filename: 'https://www.lorekit.io/_next/static/chunks/page.js',
      }),
    ).toBe(false);
  });

  it('keeps any other message, even one that starts the same way', () => {
    expect(isMutedCrossOriginError({ message: 'Script error in LoreList' })).toBe(false);
    expect(isMutedCrossOriginError({})).toBe(false);
  });
});

describe('shouldIgnoreErrorFromExtension — injected globals and muted errors', () => {
  it('drops the production Brave and Chrome iOS errors, though their stack reads as first-party', () => {
    expect(isExtensionOnlyStack(BRAVE_IOS_ETHEREUM.stack)).toBe(false);
    expect(shouldIgnoreErrorFromExtension(BRAVE_IOS_ETHEREUM)).toBe(true);
    expect(shouldIgnoreErrorFromExtension(CHROME_IOS_GCRWEB)).toBe(true);
  });

  it('drops a muted cross-origin Script error.', () => {
    expect(shouldIgnoreErrorFromExtension({ message: 'Script error.', filename: '' })).toBe(true);
  });

  it('still keeps a first-party error whose message names nothing injected', () => {
    expect(
      shouldIgnoreErrorFromExtension({
        message: "TypeError: Cannot read properties of undefined (reading 'M_ID')",
        stack: FIRST_PARTY_STACK,
      }),
    ).toBe(false);
  });
});

describe('messageOfUnknown', () => {
  it('reads the message off an Error or an error-shaped object', () => {
    expect(messageOfUnknown(new Error('boom'))).toBe('boom');
    expect(messageOfUnknown({ message: 'boom' })).toBe('boom');
  });

  it('returns undefined for anything else', () => {
    expect(messageOfUnknown('boom')).toBeUndefined();
    expect(messageOfUnknown(null)).toBeUndefined();
    expect(messageOfUnknown({ message: 42 })).toBeUndefined();
  });
});

describe('browser-injected globals never appear in our own source', () => {
  // `namesBrowserInjectedGlobal` drops an error on its message alone, which is
  // only safe while no code of ours touches these globals. If this fails, the
  // app now uses one of them: remove it from BROWSER_INJECTED_GLOBALS rather
  // than silencing our own errors.
  // Code only: comments may explain the globals, and specs quote production
  // messages that name them. The list itself lives in extension-errors.ts.
  const SRC = path.resolve(__dirname, '..');
  const EXEMPT = new Set(['lib/extension-errors.ts']);
  const INJECTED = /(?:^|[^\w$])(?:ethereum|__gCrWeb|__firefox__)(?:[^\w$]|$)/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      const isCode = /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name);
      const isTest = /\.(?:spec|test|stories)\.[jt]sx?$/.test(entry.name);
      return isCode && !isTest ? [full] : [];
    });
  }

  /** Remove block and line comments; the `[^:]` keeps `https://` intact. */
  const withoutComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('finds none in packages/web/src', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !EXEMPT.has(path.relative(SRC, file).split(path.sep).join('/')))
      .filter((file) => INJECTED.test(withoutComments(readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('would catch a real reference, and not one in a comment', () => {
    expect(INJECTED.test(withoutComments('if (window.ethereum) connect();'))).toBe(true);
    expect(INJECTED.test(withoutComments('// window.ethereum is injected by wallets'))).toBe(false);
  });
});
