import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Clock,
  XCircle,
} from 'lucide-react';
import type { UrgencyLevel } from '@/domain/deadlines';
import { STATUS_LABELS_ZH } from '@/domain/status';
import type { WorkStatus } from '@/domain/status';
import styles from './StatusBadge.module.css';

/**
 * Status and urgency badges.
 *
 * Every badge carries a text label *and* a shape/icon. The legacy prototype communicated status
 * partly through colour alone — `.wc-status.done` vs `.wc-status.undone` differed only in hue, and
 * the deadline meta line was colour-coded with no accompanying word for the `soon` state. That
 * fails WCAG 1.4.1. Here the label is always present, so a monochrome print or a colour-blind
 * reader loses nothing.
 */

const STATUS_ICONS: Readonly<Record<WorkStatus, typeof CheckCircle2>> = Object.freeze({
  todo: CircleDot,
  'in-progress': Clock,
  completed: CheckCircle2,
  cancelled: XCircle,
  deferred: CalendarClock,
});

export function StatusBadge({ status }: { readonly status: WorkStatus }): ReactNode {
  const Icon = STATUS_ICONS[status];
  return (
    <span className={`${styles.badge} ${styles[`status-${status}`]}`}>
      <Icon aria-hidden="true" size={13} />
      {STATUS_LABELS_ZH[status]}
    </span>
  );
}

export interface UrgencyBadgeProps {
  readonly level: UrgencyLevel;
  /** Already-formatted phrase, e.g. `上报时限已逾期 3 天`. */
  readonly text: string;
}

export function UrgencyBadge({ level, text }: UrgencyBadgeProps): ReactNode {
  if (level === 'closed') return null;
  const Icon = level === 'overdue' ? AlertTriangle : level === 'due-today' ? Clock : CalendarClock;
  return (
    <span className={`${styles.badge} ${styles[`urgency-${level}`]}`}>
      <Icon aria-hidden="true" size={13} />
      {text}
    </span>
  );
}

export function HonorBadge({ level }: { readonly level: string }): ReactNode {
  return (
    <span className={`${styles.badge} ${styles.honor}`}>
      {level.trim() === '' ? '荣誉' : level}
    </span>
  );
}

export function LongTermBadge(): ReactNode {
  return (
    <span className={`${styles.badge} ${styles.longTerm}`}>
      <CalendarClock aria-hidden="true" size={13} />
      长期推进
    </span>
  );
}

export function CountBadge({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}): ReactNode {
  return (
    <span className={styles.count}>
      <span aria-hidden="true">{value}</span>
      <span className="visually-hidden">
        {label} {value}
      </span>
    </span>
  );
}
