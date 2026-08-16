/**
 * Decide whether a browser error originated ENTIRELY inside a browser
 * extension, so RUM can drop it instead of reporting it as a LoreKit error.
 *
 * ## Why this exists
 *
 * A content script's uncaught error and unhandled promise rejection surface on
 * the *page's* `window`, so `@dash0/sdk-web` records them as `browser.error`
 * events attributed to `service.name=web` — even though not one line of our
 * code ran. Measured over a week of production RUM: 102 of the 105 browser
 * errors came from two visitors' extensions (a `chrome-extension://…` script
 * looping an `Unhandled promise rejection: Cannot read properties of undefined
 * (reading 'M_ID')` every ~2s, plus a MetaMask `inpage.js` connect failure),
 * against 3 genuine first-party errors. A 34:1 noise ratio makes the error rate
 * a function of what our visitors happen to have installed, which is not a
 * signal anyone can act on and not a number worth alerting on.
 *
 * ## Why the filter is stack-based and lives here
 *
 * sdk-web 0.23.0 offers exactly one error filter, `ignoreErrorMessages`, and it
 * matches the regexes against the error MESSAGE only (`vars.ignoreErrorMessages`
 * is tested against `message` before the stack is ever looked at). The observed
 * extension message — "Cannot read properties of undefined (reading 'M_ID')" —
 * is the single most common shape of a real first-party TypeError, so a message
 * regex broad enough to catch it would also silence our own bugs. The stack is
 * the only place the origin is unambiguous, so the decision is made from the
 * stack and the SDK's own filter is left alone.
 *
 * Kept pure and dependency-free (no React, no `next/*`, no node builtins),
 * matching the repo's functional-core convention — `dash0-rum.ts` owns the
 * effect of subscribing to the events, this module owns the judgement.
 */

/**
 * URL schemes that only a browser extension can serve a script from.
 *
 * Safari's `webkit-masked-url://hidden/` is deliberately ABSENT: Safari applies
 * it to extension scripts *and* to blob/worker scripts a page loads itself, so
 * treating it as proof of extension origin would silently drop real errors.
 */
const EXTENSION_URL_SCHEMES = [
  'chrome-extension',
  'moz-extension',
  'safari-web-extension',
  'safari-extension',
  'ms-browser-extension',
] as const;

/**
 * Matches an extension URL only where a stack frame's SOURCE can start: at the
 * beginning of the line, or after the whitespace / `(` / `@` / `[` that every
 * engine's frame syntax puts in front of it (`at Z (chrome-extension://…)` in
 * V8, `Z@moz-extension://…` in SpiderMonkey and JSC).
 *
 * The boundary is what stops a first-party frame from being misread as an
 * extension one when the scheme merely appears INSIDE its URL — e.g. a page
 * script loaded as `https://www.lorekit.io/x.js?ref=chrome-extension://abc`.
 */
const EXTENSION_FRAME_PATTERN = new RegExp(
  String.raw`(?:^|[\s(@\[])(?:${EXTENSION_URL_SCHEMES.join('|')}):\/\/`,
);

/**
 * Matches the two frame shapes every engine emits: V8's `    at name (url)` and
 * SpiderMonkey/JSC's `name@url` (the name may be empty, as in `@moz-extension://…`).
 *
 * The leading `TypeError: …` message line matches NEITHER — its first token
 * carries no `@`, and it does not start with `at `. That is the point: a message
 * is free-form text and may quote a URL (`Failed to fetch https://…`), so
 * treating it as a frame would let the *message* vote on origin.
 */
const STACK_FRAME_PATTERN = /^\s*(?:at\s|\S*@)/;

/**
 * A stack line only votes on origin when it is a FRAME that names a source URL.
 * `at <anonymous>`, `at Array.forEach (native)`, and the leading `TypeError: …`
 * message line carry no origin, so they are counted as neither first-party nor
 * extension rather than being guessed at in either direction.
 *
 * Both halves of the test are load-bearing. Requiring a URL alone would let a
 * message line embedding one decide: `TypeError: Failed to fetch https://api/x`
 * would vote first-party and keep an otherwise extension-only error, while
 * `Failed to load chrome-extension://…` would vote extension and drop an error
 * whose only extension mention is in its text — the dangerous direction.
 */
function isSourceBearingFrame(line: string): boolean {
  return STACK_FRAME_PATTERN.test(line) && line.includes('://');
}

function isExtensionFrame(line: string): boolean {
  return EXTENSION_FRAME_PATTERN.test(line);
}

/**
 * Whether every source-bearing frame in `stack` points at extension code.
 *
 * Returns `false` — keep the error — whenever the stack cannot prove extension
 * origin: no stack at all, no frame naming a source, or a single frame from our
 * own bundle. That last case is the important one and the reason this is
 * `every` rather than `some`: when an extension breaks OUR code the stack
 * interleaves their frames with ours, and that error is a real bug on our side
 * that we want to keep seeing.
 *
 * Failing towards keeping the error is deliberate; the cost of an unrecognised
 * stack shape is a little residual noise, never a silently swallowed bug.
 *
 * @param stack the `Error.prototype.stack` string, in any browser's format —
 *   V8's `at Z (chrome-extension://id/x.js:1:761)` and SpiderMonkey/JSC's
 *   `Z@moz-extension://id/x.js:1:761` are both handled. Frame syntax is
 *   recognised only far enough to tell a frame from the message line and to
 *   find where a source URL may start (`STACK_FRAME_PATTERN` and
 *   `EXTENSION_FRAME_PATTERN`); nothing parses a frame into function, file,
 *   line, and column, so an unfamiliar dialect degrades to "not a frame" —
 *   which keeps the error.
 */
export function isExtensionOnlyStack(stack: string | undefined | null): boolean {
  if (!stack) return false;
  return verdictOfStack(stack) === 'extension';
}

/**
 * What a stack proves about origin.
 *
 * `unattributable` is the third state the boolean above collapses away: a stack
 * exists but no line in it names a source (`at <anonymous>`, `at Array.forEach
 * (native)`), so it is evidence of nothing — as distinct from `first-party`,
 * where a frame of ours is positive proof the error is ours to keep. Callers
 * with a second source of evidence need to tell those two apart.
 */
type StackVerdict = 'extension' | 'first-party' | 'unattributable';

function verdictOfStack(stack: string): StackVerdict {
  const sourceFrames = stack.split('\n').filter(isSourceBearingFrame);
  if (sourceFrames.length === 0) return 'unattributable';
  return sourceFrames.every(isExtensionFrame) ? 'extension' : 'first-party';
}

/**
 * The subset of `ErrorEvent` / `PromiseRejectionEvent` this module reads.
 *
 * Typed structurally rather than as the DOM interfaces so the module stays
 * usable from a plain node test without a DOM lib, and so a caller can hand it
 * a rejection `reason` that is not an `Error` at all.
 */
export type ErrorOrigin = {
  /** The thrown value's stack, when the thrown value was an `Error`. */
  stack?: string | undefined | null;
  /** The script URL the event was raised from, when the host reports one. */
  filename?: string | undefined | null;
};

/**
 * Whether an error should be dropped before it reaches the SDK.
 *
 * The stack decides whenever it proves anything — an extension-only stack drops
 * the error, and a single frame of ours keeps it, outranking `filename` in both
 * directions.
 *
 * `filename` is consulted in the two cases where the stack does not: a thrown
 * non-`Error` value (`throw 'boom'`, `Promise.reject(x)`) that has no stack at
 * all, and a stack whose lines name no source (`at <anonymous>` and friends).
 * Those two are the same situation — no evidence from the stack — so they take
 * the same path; short-circuiting on the mere PRESENCE of a stack would keep an
 * error the host had already told us came from `chrome-extension://…`.
 */
export function shouldIgnoreErrorFromExtension(origin: ErrorOrigin | undefined | null): boolean {
  if (!origin) return false;

  if (origin.stack) {
    const verdict = verdictOfStack(origin.stack);
    if (verdict !== 'unattributable') return verdict === 'extension';
  }

  if (origin.filename) return isExtensionFrame(origin.filename);
  return false;
}

/**
 * Read the stack off an unknown thrown value.
 *
 * A promise can be rejected with anything — an `Error`, a DOM exception, a
 * string, a plain object shaped like an error. Only a string `stack` is
 * trusted; everything else yields `undefined` and the error is kept.
 */
export function stackOfUnknown(reason: unknown): string | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const stack = (reason as { stack?: unknown }).stack;
  return typeof stack === 'string' ? stack : undefined;
}
