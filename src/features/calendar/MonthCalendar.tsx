import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { anchorDay, daysInMonth, makeIsoDate, todayIso } from '@/domain/dates';
import type { IsoDate } from '@/domain/dates';
import { primaryDate } from '@/domain/types';
import type { AnyRecord } from '@/domain/types';
import { Button } from '@/components/common';
import styles from './MonthCalendar.module.css';

/**
 * Month calendar with per-day record counts.
 *
 * Accessibility differences from the legacy grid, which was a `div` soup of `onclick` handlers
 * with no roles and no keyboard access at all:
 *   - a real `<table role="grid">` with day-of-week column headers;
 *   - each day is a `<button>` so it is reachable by Tab and operable by Enter/Space;
 *   - the selected day is `aria-pressed`, and today is named in the accessible label;
 *   - the counts are in the button's accessible name, not only in a coloured dot.
 *
 * All arithmetic is local and date-only, via `makeIsoDate`/`daysInMonth` rather than `new Date`
 * month rollover, so a month boundary cannot shift by a timezone offset.
 */

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export interface MonthCalendarProps {
  readonly records: readonly AnyRecord[];
  readonly selected: IsoDate | null;
  readonly onSelect: (day: IsoDate | null) => void;
  readonly today?: IsoDate;
}

interface DayCell {
  readonly iso: IsoDate;
  readonly day: number;
  readonly inMonth: boolean;
  readonly work: number;
  readonly honor: number;
}

export function MonthCalendar({
  records,
  selected,
  onSelect,
  today = todayIso(),
}: MonthCalendarProps): ReactNode {
  const [cursor, setCursor] = useState(() => ({
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  }));

  const counts = useMemo(() => {
    const map = new Map<string, { work: number; honor: number }>();
    for (const record of records) {
      if (record.deletedAt !== null) continue;
      const day = anchorDay(primaryDate(record));
      if (day === null) continue;
      const entry = map.get(day) ?? { work: 0, honor: 0 };
      if (record.kind === 'work') entry.work += 1;
      else entry.honor += 1;
      map.set(day, entry);
    }
    return map;
  }, [records]);

  const cells = useMemo(
    () => buildGrid(cursor.year, cursor.month, counts),
    [cursor.year, cursor.month, counts],
  );

  const shift = (delta: number): void => {
    setCursor((current) => {
      const zeroBased = current.month - 1 + delta;
      return {
        year: current.year + Math.floor(zeroBased / 12),
        month: (((zeroBased % 12) + 12) % 12) + 1,
      };
    });
  };

  const monthLabel = `${cursor.year}年${cursor.month}月`;

  return (
    <div className={styles.calendar}>
      <div className={styles.head}>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<ChevronLeft size={16} />}
          aria-label="上个月"
          onClick={() => {
            shift(-1);
          }}
        />
        <p className={styles.title} aria-live="polite">
          {monthLabel}
        </p>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<ChevronRight size={16} />}
          aria-label="下个月"
          onClick={() => {
            shift(1);
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
          }}
        >
          今天
        </Button>
      </div>

      <table className={styles.grid} role="grid" aria-label={`${monthLabel} 记录日历`}>
        <thead>
          <tr>
            {WEEKDAYS.map((day) => (
              <th key={day} scope="col" className={styles.weekday} abbr={`星期${day}`}>
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chunk(cells, 7).map((week, index) => (
            // Weeks have no stable identity of their own; the first cell's date is unique.
            <tr key={week[0]?.iso ?? index}>
              {week.map((cell) => (
                <td key={cell.iso} className={styles.cell}>
                  <DayButton
                    cell={cell}
                    isToday={cell.iso === today}
                    isSelected={cell.iso === selected}
                    onSelect={onSelect}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotWork}`} aria-hidden="true" />
          工作
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotHonor}`} aria-hidden="true" />
          荣誉
        </span>
        {selected === null ? (
          <span className={styles.legendHint}>点日期可按当天筛选</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSelect(null);
            }}
          >
            清除日期筛选（{selected}）
          </Button>
        )}
      </p>
    </div>
  );
}

function DayButton({
  cell,
  isToday,
  isSelected,
  onSelect,
}: {
  readonly cell: DayCell;
  readonly isToday: boolean;
  readonly isSelected: boolean;
  readonly onSelect: (day: IsoDate | null) => void;
}): ReactNode {
  const total = cell.work + cell.honor;
  const parts = [cell.iso];
  if (isToday) parts.push('今天');
  if (cell.work > 0) parts.push(`工作 ${cell.work} 条`);
  if (cell.honor > 0) parts.push(`荣誉 ${cell.honor} 条`);
  if (total === 0) parts.push('无记录');

  const className = [
    styles.day,
    cell.inMonth ? '' : styles.dayOutside,
    isToday ? styles.dayToday : '',
    isSelected ? styles.daySelected : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      aria-pressed={isSelected}
      aria-label={parts.join('，')}
      onClick={() => {
        onSelect(isSelected ? null : cell.iso);
      }}
    >
      <span aria-hidden="true">{cell.day}</span>
      {total > 0 ? (
        <span className={styles.dots} aria-hidden="true">
          {cell.work > 0 ? <span className={`${styles.dot} ${styles.dotWork}`} /> : null}
          {cell.honor > 0 ? <span className={`${styles.dot} ${styles.dotHonor}`} /> : null}
        </span>
      ) : null}
    </button>
  );
}

/** Six weeks starting on Monday, so the grid height never changes between months. */
function buildGrid(
  year: number,
  month: number,
  counts: ReadonlyMap<string, { work: number; honor: number }>,
): DayCell[] {
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0 = Monday
  const total = daysInMonth(year, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevTotal = daysInMonth(prevYear, prevMonth);

  const cells: DayCell[] = [];
  const push = (y: number, m: number, d: number, inMonth: boolean): void => {
    const iso = makeIsoDate(y, m, d);
    const count = counts.get(iso);
    cells.push({ iso, day: d, inMonth, work: count?.work ?? 0, honor: count?.honor ?? 0 });
  };

  for (let i = firstWeekday; i > 0; i -= 1) push(prevYear, prevMonth, prevTotal - i + 1, false);
  for (let d = 1; d <= total; d += 1) push(year, month, d, true);

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  let d = 1;
  while (cells.length < 42) {
    push(nextYear, nextMonth, d, false);
    d += 1;
  }
  return cells;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
