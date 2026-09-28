import type { AnchorHTMLAttributes, ReactNode } from 'react';

/**
 * A link to an element on the current page that never changes the route.
 *
 * The application routes on the URL fragment (`#/work`, `#/settings`, …), so a plain in-page anchor
 * such as `href="#main"` shares the router's namespace: following it sets `location.hash` to a
 * fragment id, the router reads that as an unknown route and falls back to 概览. Until 2026-09-29 the
 * skip link and the Settings section index both did exactly that, from every route.
 *
 * This keeps the anchor — the `href` still names the target, so it reads as a same-page link and
 * works with the browser's own link affordances — but performs the jump itself for an ordinary
 * activation, which is a left click or Enter on the focused link (Enter dispatches a primary click):
 *
 *   - `align-start` scrolls the target to the top of the viewport, honouring its `scroll-margin-top`
 *     so it lands below the sticky application bar, then moves focus to it;
 *   - `focus-only` moves focus without scrolling, for a target that is always on screen, such as
 *     `<main>` for the skip link.
 *
 * No history entry is added and the address bar keeps naming the current route, so Back still
 * leaves the view rather than stepping through section jumps. Scrolling is instant: the application
 * sets no `scroll-behavior`, so a user who prefers reduced motion gets no animation here either.
 *
 * The target must be focusable — natively, or with `tabIndex={-1}` for a container.
 */

export type InPageJump = 'align-start' | 'focus-only';

export interface InPageLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The `id` of the element to move to. */
  readonly targetId: string;
  readonly jump?: InPageJump;
  readonly children: ReactNode;
}

/** Move to `target` as `jump` describes. */
function jumpToElement(target: HTMLElement, jump: InPageJump): void {
  if (jump === 'align-start') {
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
    return;
  }
  target.focus();
}

export function InPageLink({
  targetId,
  jump = 'align-start',
  onClick,
  children,
  ...rest
}: InPageLinkProps): ReactNode {
  return (
    <a
      {...rest}
      href={`#${targetId}`}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // A modified click asks the browser for a new tab or window; leave that to the browser.
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const target = document.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        jumpToElement(target, jump);
      }}
    >
      {children}
    </a>
  );
}
