import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InPageLink } from '@/components/common';

/**
 * `InPageLink` must jump without touching `location.hash`.
 *
 * The application routes on the fragment, so any in-page anchor that lets the browser follow its
 * `href` changes the route. The E2E suite proves the settled behaviour in a real browser; these pin
 * the decision rule itself: which activations are handled, and which are left to the browser.
 */

function renderWithTarget(jump?: 'align-start' | 'focus-only'): {
  link: HTMLElement;
  target: HTMLElement;
  scrollIntoView: ReturnType<typeof vi.fn>;
} {
  render(
    <>
      <InPageLink targetId="destination" {...(jump === undefined ? {} : { jump })}>
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
  it('keeps a real same-page href for the browser and assistive technology', () => {
    const { link } = renderWithTarget();
    expect(link).toHaveAttribute('href', '#destination');
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
  ] as const)('leaves a %s click to the browser', (_name, modifier) => {
    const { link, target } = renderWithTarget();
    expect(fireEvent.click(link, { button: 0, ...modifier })).toBe(true);
    expect(target).not.toHaveFocus();
  });

  it('does nothing special when the target is not on the page', () => {
    render(<InPageLink targetId="nowhere">前往</InPageLink>);
    expect(fireEvent.click(screen.getByRole('link', { name: '前往' }), { button: 0 })).toBe(true);
  });
});
