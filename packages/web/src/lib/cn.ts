/**
 * cn — join conditional class names into one string.
 *
 * The repo has no `clsx` / `tailwind-merge`, and it does not need them here: the
 * Button primitive owns every class string through lookup maps, so there are no
 * conflicting utilities to de-dupe — a truthy-filter + space-join is enough. Any
 * `false` / `null` / `undefined` part is dropped so callers can write
 * `cond && 'class'` inline.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
