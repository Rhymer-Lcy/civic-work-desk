import type { ReactNode } from 'react';
import {
  Award,
  BarChart3,
  BookOpen,
  FileText,
  LayoutDashboard,
  Plus,
  Settings,
} from 'lucide-react';
import { useCurrentPrimaryAction } from '@/app/primary-action-context';
import { ROUTES, ROUTE_LABELS_ZH, routeHref } from '@/app/router';
import type { RouteId } from '@/app/router';
import { Button } from '@/components/common';
import styles from './AppShell.module.css';

/**
 * Application chrome.
 *
 * The legacy prototype had eight equally-weighted icon buttons with `title` attributes for meaning.
 * Phase 1 replaced them with six named destinations in a real `<nav>` — correct, and kept — but split
 * the chrome across two full-width bands: a 56 px red bar carrying only the application title, and a
 * 45 px navigation strip beneath it. With the page header that is roughly 200 px of a 768 px viewport
 * spent before the first row of data (audit C-2).
 *
 * Phase 2 merges them into one 52 px band: wordmark, the same six destinations, and the current view's
 * primary action pinned to the right, where it no longer moves as page headers grow.
 *
 * **The red is kept and reduced to where it means something.** A 3 px brand rule across the top, the
 * wordmark, and the active destination's underline. A field of red behind white text is not what makes
 * an application feel official; consistency is, and red that appears only on identity and selection
 * can still be told apart from red that means "this will destroy data".
 */

const ROUTE_ICONS: Readonly<Record<RouteId, typeof LayoutDashboard>> = Object.freeze({
  dashboard: LayoutDashboard,
  work: FileText,
  honors: Award,
  ledger: BookOpen,
  reports: BarChart3,
  settings: Settings,
});

/**
 * How wide each view may grow.
 *
 * A data table and a settings form want opposite things from a 2560 px screen, so they no longer
 * share one `max-width`. Applied as a class on the shell root, which sets `--view-max` for both the
 * navigation and `main` — that is what keeps the left edge of the content aligned with the left edge
 * of the navigation as the measure changes between routes.
 */
const VIEW_WIDTH_CLASS: Readonly<Record<RouteId, string>> = Object.freeze({
  dashboard: styles.viewStandard,
  work: styles.viewStandard,
  honors: styles.viewStandard,
  ledger: styles.viewWide,
  reports: styles.viewReading,
  settings: styles.viewStandard,
});

export interface AppShellProps {
  readonly title: string;
  readonly route: RouteId;
  readonly onNavigate: (route: RouteId) => void;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({ title, route, onNavigate, banner, children }: AppShellProps): ReactNode {
  const primary = useCurrentPrimaryAction();

  return (
    <div className={`${styles.shell} ${VIEW_WIDTH_CLASS[route]}`}>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>

      <header className={`${styles.bar} app-header safe-top`}>
        <div className={styles.barInner}>
          <p className={styles.brand}>
            <span aria-hidden="true" className={styles.brandMark} />
            <span className={styles.brandText}>{title}</span>
          </p>

          <nav className={`${styles.nav} app-nav`} aria-label="主导航">
            <ul className={styles.navList}>
              {ROUTES.map((id) => {
                const Icon = ROUTE_ICONS[id];
                const current = id === route;
                return (
                  <li key={id} className={styles.navItem}>
                    <a
                      className={
                        current ? `${styles.navLink} ${styles.navLinkCurrent}` : styles.navLink
                      }
                      href={routeHref(id)}
                      aria-current={current ? 'page' : undefined}
                      onClick={(event) => {
                        // Keep the anchor semantics (middle-click, copy link) but avoid a hash
                        // round-trip for a plain left click.
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                          return;
                        event.preventDefault();
                        onNavigate(id);
                      }}
                    >
                      <Icon aria-hidden="true" size={16} className={styles.navIcon} />
                      <span>{ROUTE_LABELS_ZH[id]}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          {primary ? (
            <div className={styles.barAction}>
              <Button variant="primary" icon={<Plus size={16} />} onClick={primary.onActivate}>
                {primary.label}
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      {banner ? <div className={styles.banner}>{banner}</div> : null}

      <main id="main" className={`${styles.main} safe-bottom`} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

/**
 * Page heading plus the tools that belong to this view only.
 *
 * Creation moved to the shell, so this carries view-scoped tools (print, export) and nothing else.
 * `description` is capped at a prose measure rather than the view width: at 1920 an uncapped
 * description would run to 180 characters on one line.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <div className={styles.pageHeader}>
      <div className={styles.pageHeaderText}>
        <h1 className={styles.pageTitle}>{title}</h1>
        {description ? <p className={styles.pageDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </div>
  );
}

/**
 * Main content plus an optional aside.
 *
 * The aside is 20rem (was 17.5rem) and appears at 80rem rather than 64rem. Below that the two columns
 * stack, because a 17.5rem aside beside a shrinking main column was where the calendar and the group
 * panel became cramped enough to wrap their own headings mid-phrase (audit D-3).
 */
export function SplitLayout({
  main,
  aside,
}: {
  readonly main: ReactNode;
  readonly aside: ReactNode;
}): ReactNode {
  return (
    <div className={`${styles.split} app-layout`}>
      <div className={styles.splitMain}>{main}</div>
      <aside className={`${styles.splitAside} app-sidebar`} aria-label="侧边信息">
        {aside}
      </aside>
    </div>
  );
}

/**
 * A titled region of a page, with no box around it.
 *
 * The counterweight to card-for-everything (audit C-3). Nine bordered white cards on a cream page
 * stop separating anything, so most groupings now use a heading, spacing and an optional rule —
 * and a `Card` is reserved for content that genuinely needs to read as one detachable object.
 */
export function Section({
  title,
  description,
  actions,
  headingLevel = 2,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly headingLevel?: 2 | 3;
  readonly children: ReactNode;
}): ReactNode {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionHeadText}>
          <Heading className={styles.sectionTitle}>{title}</Heading>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
