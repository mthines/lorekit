import type { AuthMethod } from './auth-telemetry';

/**
 * The once-per-document rule behind `auth.option_selected`.
 *
 * `auth.option_selected` answers "how many visitors even tried this route?", so
 * a route counts ONCE per document however many times it is picked. The login
 * panels can be toggled back and forth all day, and each switch is the same
 * visitor showing the same interest — counting every one of them would inflate
 * the selection side of the selection-minus-attempt gap until it stopped being
 * an abandonment rate at all.
 *
 * This lives here, apart from the component that owns the set, for one reason:
 * the rule is the thing the metric depends on, and a rule inlined in a `.tsx`
 * component is out of reach of this package's default unit target —
 * `vitest.config.ts` includes only `.spec.ts` and `.test.ts` files under `src`,
 * and there is no jsdom in the dependency tree to render a component under it.
 * The one React harness this package does have is the separate browser-mode
 * `test-storybook` target (`vitest.storybook.config.ts` runs `*.test.stories.tsx`
 * in Chromium), a heavier place to pin a counting rule than a pure function. As
 * a pure function over a caller-owned `Set` it is covered by the harness that
 * already runs, and `LoginButton` keeps the `useRef` that makes the set survive
 * a re-render.
 *
 * Mutates `selected` in place and reports whether this call was the first
 * sighting — so the caller emits when, and only when, this returns `true`.
 *
 * @param selected The methods already selected in this document. Mutated.
 * @param method The method the visitor just picked.
 * @returns `true` on the first selection of `method`, `false` on every repeat.
 */
export function markOptionSelected(selected: Set<AuthMethod>, method: AuthMethod): boolean {
  if (selected.has(method)) return false;
  selected.add(method);
  return true;
}
