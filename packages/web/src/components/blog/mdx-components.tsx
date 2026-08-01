import type { MDXComponents } from 'mdx/types';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { SmartLink } from '@/components/docs/SmartLink';

/**
 * Component map handed to `<MDXRemote>` for every blog post.
 *
 * - `a` routes internal links through `next/link` (see {@link SmartLink}) — the
 *   same renderer the docs use, so `[label](/docs/x)` behaves everywhere.
 * - `TutorialCallout` is available in MDX scope with no import, so a post can drop
 *   a Note/Tip/Warning box the same way a docs page does.
 *
 * Prose element styling lives in {@link BlogProse} (Tailwind child selectors),
 * so it is intentionally absent here.
 */
export const blogMdxComponents: MDXComponents = {
  a: SmartLink as MDXComponents['a'],
  TutorialCallout: TutorialCallout as unknown as MDXComponents['div'],
};
