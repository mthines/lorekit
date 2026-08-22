'use client';

/**
 * The one place the 3D map is allowed to fail.
 *
 * WebGL is the only part of this dashboard that can be unavailable for reasons
 * that have nothing to do with the code being correct: a GPU blocklisted by the
 * browser, a driver crash, `webgl.disabled` in a hardened profile, a headless
 * or virtualised environment, or simply too many live contexts on the page
 * (browsers cap them at roughly 8–16 and evict the oldest). React Three Fiber
 * throws when it cannot acquire a context, and an unhandled throw inside a
 * `lazy` boundary takes the whole route down — so a visitor whose GPU the
 * browser dislikes would lose the Lore page, not just the map.
 *
 * That is the entire justification for a class component in a codebase that has
 * none: `componentDidCatch` has no hook equivalent, and React has no other way
 * to contain a render-time throw.
 *
 * The fallback is deliberately not an apology. The map is a second view of a
 * list that is still there and still complete, so the honest message is "use
 * the list", not "something went wrong" — the reader has lost a nicety, not
 * their data, and the copy should say which.
 */

import { Component, type ReactNode } from 'react';
import { MonitorX } from 'lucide-react';

interface SceneBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the scene once it has thrown. */
  onFailure?: () => void;
}

interface SceneBoundaryState {
  failed: boolean;
}

export class SceneBoundary extends Component<SceneBoundaryProps, SceneBoundaryState> {
  override state: SceneBoundaryState = { failed: false };

  static getDerivedStateFromError(): SceneBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Reported, not swallowed. A silent fallback would make "the map is blank
    // for some users" unobservable, and the RUM/OTel pipeline is how this
    // dashboard finds out about client-side breakage at all.
    console.error('[lore-graph] scene failed to render', error);
    this.props.onFailure?.();
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
        role="status"
      >
        <MonitorX aria-hidden="true" className="size-6 text-[var(--color-content-tertiary)]" />
        <p className="text-sm text-[var(--color-content-primary)]">
          This browser can’t draw the 3D map
        </p>
        <p className="max-w-sm text-xs text-[var(--color-content-secondary)]">
          It needs WebGL, which is unavailable or disabled here. Switch to List to browse the same
          memories — nothing is missing from it.
        </p>
      </div>
    );
  }
}
