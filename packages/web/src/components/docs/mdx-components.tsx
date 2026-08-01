import type { MDXComponents } from 'mdx/types';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { GettingStartedContentServer } from '@/components/learn/GettingStartedContentServer';
import { SmartLink } from './SmartLink';

/**
 * Component map handed to `<MDXRemote>` for every docs page.
 *
 * - `a` routes internal links through `next/link` (see {@link SmartLink}).
 * - The bespoke authoring components (`TutorialStep`, `TutorialCallout`) and the
 *   shared `GettingStartedContent` are in MDX scope with no import, so the
 *   content files stay pure prose + JSX.
 *
 * Prose element styling lives in {@link DocsProse} (Tailwind child selectors),
 * so it is intentionally absent here.
 */
// The `as unknown as MDXComponents['div']` casts bridge our custom component
// prop types to the MDX component-map slot type: MDXComponents keys are typed as
// intrinsic-element renderers, but MDX passes our JSX props (`number`, `title`,
// `variant`, `isPublic`) straight through at runtime, so the structural mismatch
// is intentional and load-bearing.
export const docsMdxComponents: MDXComponents = {
  a: SmartLink as MDXComponents['a'],
  TutorialStep: TutorialStep as unknown as MDXComponents['div'],
  TutorialCallout: TutorialCallout as unknown as MDXComponents['div'],
  // The async server wrapper pre-highlights the tutorial's code (the docs MDX
  // render is server-side, so async is fine); the client dialog keeps using the
  // plain component directly.
  GettingStartedContent: GettingStartedContentServer as unknown as MDXComponents['div'],
};
