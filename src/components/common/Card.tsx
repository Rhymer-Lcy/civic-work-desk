import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import styles from './Card.module.css';

/**
 * Surfaces.
 *
 * One level of elevation only. The legacy layout nested cards inside cards inside a card — a
 * `.set-card` containing `.set-item` blocks each with their own border and background — which
 * produced four visible boxes around a single text field. `Card` is the only card; anything
 * inside it uses `Panel` (a flat, bordered region) or plain rows.
 */

export interface CardProps {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly actions?: ReactNode | undefined;
  readonly children: ReactNode;
  /** Renders the heading at this level so the document outline stays correct. */
  readonly headingLevel?: 2 | 3 | undefined;
  readonly className?: string | undefined;
}

export function Card({
  title,
  description,
  actions,
  children,
  headingLevel = 2,
  className,
}: CardProps): ReactNode {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={[styles.card, className].filter(Boolean).join(' ')}>
      {title ? (
        <header className={styles.header}>
          <div className={styles.headerText}>
            <Heading className={styles.title}>{title}</Heading>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A flat bordered region used *inside* a card. Never nests further. */
export function Panel({
  children,
  tone = 'default',
}: {
  readonly children: ReactNode;
  readonly tone?: 'default' | 'warning' | 'danger' | 'info';
}): ReactNode {
  return <div className={`${styles.panel} ${styles[`tone-${tone}`]}`}>{children}</div>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: ReactNode | undefined;
}): ReactNode {
  return (
    <div className={styles.empty}>
      <Inbox aria-hidden="true" size={32} className={styles.emptyIcon} />
      <p className={styles.emptyTitle}>{title}</p>
      {description ? <p className={styles.emptyDescription}>{description}</p> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

/** A labelled statistic. `emphasis` is for the one or two numbers that drive action. */
export function Metric({
  label,
  value,
  detail,
  emphasis = 'normal',
  onActivate,
  activateLabel,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly detail?: string | undefined;
  readonly emphasis?: 'normal' | 'alert' | 'positive' | undefined;
  readonly onActivate?: (() => void) | undefined;
  readonly activateLabel?: string | undefined;
}): ReactNode {
  const inner = (
    <>
      <span className={`${styles.metricValue} ${styles[`metric-${emphasis}`]}`}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
      {detail ? <span className={styles.metricDetail}>{detail}</span> : null}
    </>
  );
  if (!onActivate) return <div className={styles.metric}>{inner}</div>;
  return (
    <button
      type="button"
      className={`${styles.metric} ${styles.metricButton}`}
      onClick={onActivate}
      aria-label={activateLabel ?? `查看${label}`}
    >
      {inner}
    </button>
  );
}
