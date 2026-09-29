import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { RouteHref } from '@/app/router';

/**
 * A link to an element on the current page whose real `href` is a valid application route.
 *
 * The application routes on the URL fragment (`#/work`, `#/settings`, …), so the fragment is not
 * free for section ids. A plain `href="#main"` or `href="#settings-data"` is read by the router as an
 * unknown route and answered with 概览: until 2026-09-29 the skip link and the Settings section index
 * did exactly that on an ordinary click, and — after the first correction, which only intercepted
 * ordinary clicks — still did it on every modified click, middle click, "open in new tab" and copied
 * link, because the browser followed the raw fragment.
 *
 * The contract now has two separate parts:
 *
 *   - `href` is what the browser sees and uses for everything this component does not handle — a
 *     modified or middle click, "open in new tab", "copy link address". It must be a
 *     route (`routeHref(...)`; the type refuses anything else), normally the route the link is on, so
 *     those paths land on the correct view. The section position is not encoded in the URL and is not
 *     restored there; only the view is.
 *   - `targetId` is where an ordinary activation — a left click, or Enter on the focused link (Enter
 *     dispatches a primary click) — jumps, in place, without navigating:
 *       - `align-start` scrolls the target to the top of the viewport, honouring its
 *         `scroll-margin-top` so it lands below the sticky application bar, then moves focus to it;
 *       - `focus-only` moves focus without scrolling, for a target that is always on screen, such as
 *         `<main>` for the skip link.
 *
 * An ordinary activation adds no history entry and leaves the address bar naming the current route,
 * so Back still leaves the view rather than stepping through section jumps. Scrolling is instant: the
 * application sets no `scroll-behavior`, so a user who prefers reduced motion gets no animation here.
 *
 * The target must be focusable — natively, or with `tabIndex={-1}` for a container.
 */

export type InPageJump = 'align-start' | 'focus-only';

export interface InPageLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The browser-visible href: a route, used by every activation this link does not handle itself. */
  readonly href: RouteHref;
  /** The `id` of the element an ordinary activation moves to. */
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
  href,
  targetId,
  jump = 'align-start',
  onClick,
  children,
  ...rest
}: InPageLinkProps): ReactNode {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // A modified click asks the browser for a new tab or window; it follows `href`, a route.
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
