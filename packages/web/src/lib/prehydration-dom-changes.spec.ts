import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import {
  PREHYDRATION_WATCH_TIMEOUT_MS,
  describeLocation,
  describeMutation,
  describeNode,
  isHydrationErrorMessage,
  isReactOwned,
  summarizeDomChanges,
  watchPrehydrationDomChanges,
  type DomMutation,
} from './prehydration-dom-changes';

// These specs run in the `node` environment (the package has no DOM
// environment), so nodes, the document and the observer are minimal
// stand-ins carrying exactly the properties the module reads.

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  id?: string;
  parentNode: FakeNode | null;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
}

const asNode = (node: FakeNode) => node as unknown as Node;

function element(tag: string, parent: FakeNode | null = null, id = ''): FakeNode {
  const attributes: Record<string, string> = {};
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    id,
    parentNode: parent,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
}

function textNode(parent: FakeNode | null): FakeNode {
  return { nodeType: 3, nodeName: '#text', parentNode: parent };
}

/** Mark a node the way react-dom does when it hydrates or creates it. */
function owned<T extends FakeNode>(node: T): T {
  (node as unknown as Record<string, unknown>)['__reactFiber$k3x9'] = {};
  return node;
}

function mutation(partial: Partial<Omit<DomMutation, 'target'>> & { target: FakeNode }): DomMutation {
  return {
    type: 'childList',
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    attributeName: null,
    ...partial,
    target: asNode(partial.target),
  } as DomMutation;
}

const nodes = (...list: FakeNode[]) => list.map(asNode) as unknown as NodeList;

// A small page: <html><body><main><article><p>text</p></article></main></body></html>
function page() {
  const html = element('html');
  const body = element('body', html);
  const main = element('main', body);
  const article = element('article', main);
  const p = element('p', article);
  const text = textNode(p);
  return { html, body, main, article, p, text };
}

describe('isReactOwned', () => {
  it('recognises the fiber key react-dom stamps on nodes it owns', () => {
    expect(isReactOwned(asNode(owned(element('p'))))).toBe(true);
  });

  it('treats an unstamped node, and no node, as not owned', () => {
    expect(isReactOwned(asNode(element('p')))).toBe(false);
    expect(isReactOwned(null)).toBe(false);
  });
});

describe('isHydrationErrorMessage', () => {
  it('matches the minified React 19 hydration error with or without args', () => {
    expect(
      isHydrationErrorMessage(
        'Error: Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message',
      ),
    ).toBe(true);
    expect(isHydrationErrorMessage('Minified React error #418;')).toBe(true);
  });

  it('matches the React 18 codes and the unminified development wording', () => {
    expect(isHydrationErrorMessage('Minified React error #423;')).toBe(true);
    expect(isHydrationErrorMessage('Minified React error #425;')).toBe(true);
    expect(isHydrationErrorMessage("Hydration failed because the server rendered HTML didn't match the client.")).toBe(true);
  });

  it('does not match other React errors or non-strings', () => {
    expect(isHydrationErrorMessage('Minified React error #4180;')).toBe(false);
    expect(isHydrationErrorMessage('Minified React error #310;')).toBe(false);
    expect(isHydrationErrorMessage(undefined)).toBe(false);
  });
});

describe('describeNode / describeLocation', () => {
  it('names an element by lower-cased tag and id, and other nodes by nodeName', () => {
    expect(describeNode(asNode(element('DIV', null, 'root')))).toBe('div#root');
    expect(describeNode(asNode(element('FONT')))).toBe('font');
    expect(describeNode(asNode(textNode(null)))).toBe('#text');
  });

  it('shows the nearest three elements, outermost first', () => {
    const { p, text } = page();
    expect(describeLocation(asNode(p))).toBe('main>article>p');
    // A text node is located by its parent element.
    expect(describeLocation(asNode(text))).toBe('main>article>p');
  });

  it('stops at <body>', () => {
    const { body, main } = page();
    expect(describeLocation(asNode(body))).toBe('body');
    expect(describeLocation(asNode(main))).toBe('body>main');
  });

  it('marks a node with no element ancestry as detached', () => {
    expect(describeLocation(asNode(textNode(null)))).toBe('(detached)');
  });
});

describe('describeMutation', () => {
  it('describes added and removed nodes at their location', () => {
    const { p } = page();
    const entries = describeMutation(
      mutation({
        target: p,
        addedNodes: nodes(element('font'), textNode(null)),
        removedNodes: nodes(textNode(null)),
      }),
    );
    expect(entries).toEqual([
      '+font in main>article>p',
      '+#text in main>article>p',
      '-#text in main>article>p',
    ]);
  });

  it('describes a text change by where the text sits — never its content', () => {
    const { text } = page();
    expect(describeMutation(mutation({ type: 'characterData', target: text }))).toEqual([
      '~#text in main>article>p',
    ]);
  });

  it('describes a rewritten page language with its new value', () => {
    const html = element('html');
    html.setAttribute?.('lang', 'fr');
    expect(describeMutation(mutation({ type: 'attributes', target: html, attributeName: 'lang' }))).toEqual([
      'html[lang]=fr',
    ]);
  });

  it('skips a change whose target React already owns — it cannot cause a mismatch', () => {
    const { p } = page();
    owned(p);
    expect(describeMutation(mutation({ target: p, addedNodes: nodes(element('span')) }))).toEqual([]);
  });

  it('skips nodes React added or removed itself under an unowned target', () => {
    const { p } = page();
    const entries = describeMutation(
      mutation({ target: p, addedNodes: nodes(owned(element('span')), element('font')) }),
    );
    expect(entries).toEqual(['+font in main>article>p']);
  });

  it('skips a text change React makes through an owned parent (string children get no fiber)', () => {
    const { p, text } = page();
    owned(p);
    expect(describeMutation(mutation({ type: 'characterData', target: text }))).toEqual([]);
  });
});

describe('summarizeDomChanges', () => {
  it('keeps first-seen order and marks repeats with a count', () => {
    const counts = new Map([
      ['+font in main>article>p', 12],
      ['html[lang]=fr', 1],
    ]);
    expect(summarizeDomChanges(counts)).toBe('+font in main>article>p ×12; html[lang]=fr');
  });

  it('folds entries past the eighth into a count', () => {
    const counts = new Map(Array.from({ length: 11 }, (_, i) => [`+span#s${i} in body`, 1] as const));
    const summary = summarizeDomChanges(counts);
    expect(summary.split('; ')).toHaveLength(9);
    expect(summary.endsWith('…+3 more')).toBe(true);
  });

  it('caps the string length', () => {
    const counts = new Map([[`+div#${'x'.repeat(2000)} in body`, 1]]);
    const summary = summarizeDomChanges(counts);
    expect(summary.length).toBe(512);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('watchPrehydrationDomChanges', () => {
  class FakeObserver {
    static last: FakeObserver | undefined;
    observed: Array<{ target: unknown; options: MutationObserverInit }> = [];
    disconnected = false;
    constructor(readonly callback: (records: DomMutation[]) => void) {
      FakeObserver.last = this;
    }
    observe(target: unknown, options: MutationObserverInit) {
      this.observed.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  function fakeDocument(readyState: DocumentReadyState = 'interactive') {
    const { html, body, p } = page();
    const win = Object.assign(new EventTarget(), {
      MutationObserver: FakeObserver,
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
    const doc = Object.assign(new EventTarget(), {
      readyState,
      defaultView: win,
      documentElement: html,
      body,
    });
    return { doc: doc as unknown as Document, win, docState: doc, p };
  }

  function errorEvent(message: string): Event {
    const event = new Event('error');
    Object.defineProperty(event, 'message', { value: message });
    Object.defineProperty(event, 'error', { value: new Error(message) });
    return event;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeObserver.last = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null where it cannot observe — no document, or no MutationObserver', () => {
    const onChange = vi.fn();
    const onStop = vi.fn();
    expect(watchPrehydrationDomChanges({ onChange, onStop, doc: undefined })).toBeNull();

    const { doc, win } = fakeDocument();
    Object.assign(win, { MutationObserver: undefined });
    expect(watchPrehydrationDomChanges({ onChange, onStop, doc })).toBeNull();
  });

  it('watches <html> lang/dir and the whole <body> once parsing has finished', () => {
    const { doc } = fakeDocument();
    watchPrehydrationDomChanges({ onChange: vi.fn(), onStop: vi.fn(), doc });

    expect(FakeObserver.last?.observed).toEqual([
      { target: doc.documentElement, options: { attributes: true, attributeFilter: ['lang', 'dir'] } },
      { target: doc.body, options: { childList: true, characterData: true, subtree: true } },
    ]);
  });

  it('waits for the parser while the document is still loading', () => {
    const { doc, docState } = fakeDocument('loading');
    watchPrehydrationDomChanges({ onChange: vi.fn(), onStop: vi.fn(), doc });
    expect(FakeObserver.last?.observed).toEqual([]);

    docState.readyState = 'interactive';
    docState.dispatchEvent(new Event('readystatechange'));
    expect(FakeObserver.last?.observed).toHaveLength(2);
  });

  it('reports a running count and de-duplicated summary for changes React does not own', () => {
    const { doc, p } = fakeDocument();
    const onChange = vi.fn();
    watchPrehydrationDomChanges({ onChange, onStop: vi.fn(), doc });

    const font = () => mutation({ target: p, addedNodes: nodes(element('font')) });
    FakeObserver.last?.callback([font(), font()]);
    FakeObserver.last?.callback([font()]);

    expect(onChange).toHaveBeenLastCalledWith({ count: 3, summary: '+font in main>article>p ×3' });
  });

  it('stays silent for a batch made only of React-owned changes', () => {
    const { doc, p } = fakeDocument();
    const onChange = vi.fn();
    watchPrehydrationDomChanges({ onChange, onStop: vi.fn(), doc });

    owned(p);
    FakeObserver.last?.callback([mutation({ target: p, addedNodes: nodes(element('span')) })]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops one task AFTER a hydration error, so the SDK captures the error with the summary first', () => {
    const { doc, win } = fakeDocument();
    const onStop = vi.fn();
    watchPrehydrationDomChanges({ onChange: vi.fn(), onStop, doc });

    win.dispatchEvent(errorEvent('Error: Minified React error #418; visit https://react.dev/errors/418?args[]=HTML'));
    expect(onStop).not.toHaveBeenCalled();
    expect(FakeObserver.last?.disconnected).toBe(false);

    vi.advanceTimersByTime(0);
    expect(onStop).toHaveBeenCalledOnce();
    expect(FakeObserver.last?.disconnected).toBe(true);
  });

  it('keeps watching through errors that are not hydration errors', () => {
    const { doc, win } = fakeDocument();
    const onStop = vi.fn();
    watchPrehydrationDomChanges({ onChange: vi.fn(), onStop, doc });

    win.dispatchEvent(errorEvent("TypeError: Cannot read properties of undefined (reading 'x')"));
    vi.advanceTimersByTime(0);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('stops at the deadline when no hydration error arrives', () => {
    const { doc } = fakeDocument();
    const onStop = vi.fn();
    watchPrehydrationDomChanges({ onChange: vi.fn(), onStop, doc });

    vi.advanceTimersByTime(PREHYDRATION_WATCH_TIMEOUT_MS - 1);
    expect(onStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('calls onStop once however many times it is stopped', () => {
    const { doc, win } = fakeDocument();
    const onStop = vi.fn();
    const stop = watchPrehydrationDomChanges({ onChange: vi.fn(), onStop, doc });

    stop?.();
    stop?.();
    win.dispatchEvent(errorEvent('Minified React error #418;'));
    vi.advanceTimersByTime(PREHYDRATION_WATCH_TIMEOUT_MS);
    expect(onStop).toHaveBeenCalledOnce();
  });
});
