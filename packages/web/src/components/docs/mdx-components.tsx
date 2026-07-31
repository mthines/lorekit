import type { MDXComponents } from 'mdx/types';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { GettingStartedContent } from '@/components/learn/GettingStartedContent';
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
export const docsMdxComponents: MDXComponents = {
  a: SmartLink as MDXComponents['a'],
  TutorialStep: TutorialStep as unknown as MDXComponents['div'],
  TutorialCallout: TutorialCallout as unknown as MDXComponents['div'],
  GettingStartedContent: GettingStartedContent as unknown as MDXComponents['div'],
};
