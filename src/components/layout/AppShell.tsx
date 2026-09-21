import type { ReactNode } from 'react';
import { Award, BarChart3, BookOpen, FileText, LayoutDashboard, Settings } from 'lucide-react';
import { ROUTES, ROUTE_LABELS_ZH, routeHref } from '@/app/router';
import type { RouteId } from '@/app/router';
import styles from './AppShell.module.css';

/**
 * Application chrome.
 *
 * The legacy header carried seven icon-only buttons — statistics, ledger, settings, Excel export,
 * Word report, honour compilation, JSON export, JSON import — each a 34px square with only a
 * `title` attribute for meaning. Eight equally-weighted destinations, no hierarchy, and the
 * everyday action (add a record) was a floating circle in the corner.
 *
 * Here navigation is six named destinations in a real `<nav>`, exports live inside the view that
 * owns them (Reports, Settings), and there is exactly one primary action.
 */

const ROUTE_ICONS: Readonly<Record<RouteId, typeof LayoutDashboard>> = Object.freeze({
  dashboard: LayoutDashboard,
  work: FileText,
  honors: Award,
  ledger: BookOpen,
  reports: BarChart3,
  settings: Settings,
});

export interface AppShellProps {
  readonly title: string;
  readonly route: RouteId;
  readonly onNavigate: (route: RouteId) => void;
  readonly primaryAction?: ReactNode;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({
  title,
  route,
  onNavigate,
  primaryAction,
  banner,
  children,
}: AppShellProps): ReactNode {
  return (
    <>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <header className={`${styles.header} app-header safe-top`}>
        <div className={styles.headerInner}>
          <p className={styles.brand}>{title}</p>
          {primaryAction ? <div className={styles.headerAction}>{primaryAction}</div> : null}
        </div>
      </header>

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
                  <Icon aria-hidden="true" size={18} />
                  <span>{ROUTE_LABELS_ZH[id]}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {banner ? <div className={styles.banner}>{banner}</div> : null}

      <main id="main" className={`${styles.main} safe-bottom`} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}

/** Page heading plus its own tools. Every route renders exactly one. */
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

/** Two-column layout: main content plus an optional aside that stacks below 64rem. */
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
