import Link from 'next/link';
import type { AnchorHTMLAttributes } from 'react';

/**
 * The `a` renderer for MDX docs. Internal links (`/…` or `#…`) route through
 * `next/link` for client-side navigation; external links open in a new tab with
 * the usual `rel` hardening. Keeps authored markdown links (`[text](/docs/x)`)
 * behaving correctly without the author thinking about it.
 */
export function SmartLink({ href = '', children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isInternal = href.startsWith('/') || href.startsWith('#');
  if (isInternal) {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}
