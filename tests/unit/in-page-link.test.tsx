import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { routeHref } from '@/app/router';
import { InPageLink } from '@/components/common';
import type { InPageLinkProps } from '@/components/common/InPageLink';

/**
 * `InPageLink` must jump without touching `location.hash`, and its real `href` must be a route.
 *
 * The application routes on the fragment, so any activation the browser handles — a modified or
 * middle click, a new tab, a copied link — follows the `href`, and a section id there opens as an
 * unknown route. The E2E suite proves the settled behaviour in a real browser; these pin the decision
 * rule itself: which activations are handled, which are left to the browser, and what the browser is
 * given to follow.
 */

function renderWithTarget(jump?: 'align-start' | 'focus-only'): {
  link: HTMLElement;
  target: HTMLElement;
  scrollIntoView: ReturnType<typeof vi.fn>;
} {
  render(
    <>
      <InPageLink
        href={routeHref('settings')}
        targetId="destination"
        {...(jump === undefined ? {} : { jump })}
      >
        前往
      </InPageLink>
      <section id="destination" tabIndex={-1}>
        目标
      </section>
    </>,
  );
  const target = document.getElementById('destination');
  if (!target) throw new Error('target not rendered');
  // jsdom implements no layout, so `scrollIntoView` does not exist on its elements.
  const scrollIntoView = vi.fn();
  target.scrollIntoView = scrollIntoView;
  return { link: screen.getByRole('link', { name: '前往' }), target, scrollIntoView };
}

describe('InPageLink', () => {
  it('accepts only a route as its href: a section id does not compile', () => {
    const asHref = (href: InPageLinkProps['href']): string => href;
    // @ts-expect-error — `#main` is not a route; the router would answer it with 概览.
    expect(asHref('#main')).toBe('#main');
    expect(asHref(routeHref('ledger'))).toBe('#/ledger');
  });

  it('exposes the given route as its real href, never the section id', () => {
    const { link } = renderWithTarget();
    expect(link).toHaveAttribute('href', '#/settings');
    expect(link.getAttribute('href')).not.toContain('destination');
  });

  it('handles an ordinary activation itself: no navigation, focus moves to the target', () => {
    const before = window.location.hash;
    const { link, target, scrollIntoView } = renderWithTarget();
    const followed = fireEvent.click(link, { button: 0 });

    // `fireEvent` returns false when the default action was prevented.
    expect(followed).toBe(false);
    expect(window.location.hash).toBe(before);
    expect(target).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('focus-only moves focus without scrolling', () => {
    const { link, target, scrollIntoView } = renderWithTarget('focus-only');
    expect(fireEvent.click(link, { button: 0 })).toBe(false);
    expect(target).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
  ] as const)(
    'leaves a %s click to the browser, which follows the route href',
    (_name, modifier) => {
      const { link, target } = renderWithTarget();
      expect(fireEvent.click(link, { button: 0, ...modifier })).toBe(true);
      expect(target).not.toHaveFocus();
      expect(link).toHaveAttribute('href', '#/settings');
    },
  );

  it('does nothing special when the target is not on the page', () => {
    render(
      <InPageLink href={routeHref('work')} targetId="nowhere">
        前往
      </InPageLink>,
    );
    expect(fireEvent.click(screen.getByRole('link', { name: '前往' }), { button: 0 })).toBe(true);
  });
});
