import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import styles from './BackToTop.module.css';

/**
 * 回到顶部 — a floating control that appears once the page has been scrolled a meaningful distance.
 *
 * **When it shows.** After more than one viewport height of scrolling, and never before 400 px: a
 * control that appeared after a nudge would be clutter on every medium-length page. The position is
 * read in a passive scroll listener throttled to one animation frame, and re-read on resize and on
 * every route change — a route change does not reset the scroll position here, and a shorter page can
 * clamp it without the user scrolling at all.
 *
 * **Hidden means absent.** The `hidden` attribute takes it out of the tab order and the accessibility
 * tree, so nobody tabs onto a control that does nothing.
 *
 * **Activation.** Smooth scrolling, unless the user prefers reduced motion, in which case the jump is
 * instant. Focus then moves to `<main>` (without a second scroll): the button hides itself as the page
 * nears the top, and a focused element that becomes hidden drops focus to `<body>`, which would leave a
 * keyboard or screen-reader user nowhere. `<main>` is the same landing point the skip link uses.
 *
 * **Stacking.** Below the header, dialogs and toasts, so any of them covers the button rather than the
 * reverse; offset by the safe-area insets so it clears a phone's rounded corners and home indicator.
 */

const MIN_THRESHOLD_PX = 400;
const MAIN_ID = 'main';

function scrolledFarEnough(): boolean {
  return window.scrollY > Math.max(MIN_THRESHOLD_PX, window.innerHeight);
}

export function BackToTop({ routeKey }: { readonly routeKey: string }): ReactNode {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      frame = 0;
      setVisible(scrolledFarEnough());
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    // Evaluate now as well: `routeKey` changed, and the new view may already sit at another offset.
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [routeKey]);

  return (
    <button
      type="button"
      className={styles.button}
      aria-label="回到顶部"
      title="回到顶部"
      hidden={!visible}
      onClick={() => {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        document.getElementById(MAIN_ID)?.focus({ preventScroll: true });
      }}
    >
      <ArrowUp aria-hidden="true" size={20} />
    </button>
  );
}
