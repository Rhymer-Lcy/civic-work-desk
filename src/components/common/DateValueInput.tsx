import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { dateValueFromInput, dateValueFromRange, textDateValue } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import styles from './DateValueInput.module.css';

/**
 * Editor for a `DateValue`.
 *
 * The user picks the *kind* of date first, which is the honest model: the real data contains
 * `待定（4月前）`, `3月5日12时前` and `长期推进` in deadline fields, and a bare `<input type="date">`
 * cannot hold any of them. The legacy form had an equivalent three-way select, but it stored the
 * choice in a separate `xType` field that then disagreed with the value — rows exist with
 * `deadlineType: "date"` and free text in `deadline`, and with `dueType: ""` and a populated `due`.
 *
 * The chosen kind is *local* state while a half-typed range exists, and the committed `DateValue`
 * is only ever well-formed. That keeps the invariant (`start <= end`, both real days) true at every
 * moment in the store without the radio selection jumping while the user is still typing.
 */

export interface DateValueInputProps {
  readonly value: DateValue;
  readonly onChange: (next: DateValue) => void;
  readonly legend: string;
  readonly hint?: string | undefined;
  readonly textPlaceholder?: string | undefined;
  /** Hide the range option where a range is meaningless (e.g. a completion date). */
  readonly allowRange?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

type Kind = DateValue['kind'];

const KIND_LABELS: Readonly<Record<Kind, string>> = Object.freeze({
  absent: '无',
  plain: '具体日期',
  range: '日期区间',
  text: '文字说明',
});

export function DateValueInput({
  value,
  onChange,
  legend,
  hint,
  textPlaceholder = '如：4月前 / 3月5日12时前',
  allowRange = true,
  disabled = false,
}: DateValueInputProps): ReactNode {
  const groupName = useId();
  const plainId = useId();
  const startId = useId();
  const endId = useId();
  const textId = useId();

  // Seeded from the incoming value. The dialogs that host this control mount fresh on open, so
  // there is no need to re-sync from an effect when the edited record changes.
  const [kind, setKind] = useState<Kind>(value.kind);
  const [rangeStart, setRangeStart] = useState(value.kind === 'range' ? value.start : '');
  const [rangeEnd, setRangeEnd] = useState(value.kind === 'range' ? value.end : '');

  const kinds: Kind[] = allowRange
    ? ['absent', 'plain', 'range', 'text']
    : ['absent', 'plain', 'text'];

  const commitRange = (start: string, end: string): void => {
    setRangeStart(start);
    setRangeEnd(end);
    // An incomplete range degrades to whichever single day is present, or to absent — never to a
    // malformed range object.
    onChange(dateValueFromRange(start, end));
  };

  const switchKind = (next: Kind): void => {
    setKind(next);
    switch (next) {
      case 'absent':
        onChange({ kind: 'absent' });
        break;
      case 'plain':
        onChange(dateValueFromInput(value.kind === 'range' ? value.start : ''));
        break;
      case 'range': {
        const seed = value.kind === 'plain' ? value.date : '';
        setRangeStart(seed);
        setRangeEnd(seed);
        onChange(dateValueFromRange(seed, seed));
        break;
      }
      case 'text':
        onChange(textDateValue(value.kind === 'text' ? value.text : ''));
        break;
    }
  };

  return (
    <fieldset className={styles.wrapper} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.kinds} role="radiogroup" aria-label={`${legend}类型`}>
        {kinds.map((option) => (
          <label key={option} className={styles.kindOption}>
            <input
              type="radio"
              name={groupName}
              value={option}
              checked={kind === option}
              onChange={() => {
                switchKind(option);
              }}
            />
            <span>{KIND_LABELS[option]}</span>
          </label>
        ))}
      </div>

      {kind === 'plain' ? (
        <>
          <label className="visually-hidden" htmlFor={plainId}>
            {legend}
          </label>
          <input
            id={plainId}
            className={styles.control}
            type="date"
            value={value.kind === 'plain' ? value.date : ''}
            onChange={(event) => {
              onChange(dateValueFromInput(event.target.value));
            }}
          />
        </>
      ) : null}

      {kind === 'range' ? (
        <div className={styles.range}>
          <div className={styles.rangePart}>
            <label className={styles.rangeLabel} htmlFor={startId}>
              起
            </label>
            <input
              id={startId}
              className={styles.control}
              type="date"
              value={rangeStart}
              onChange={(event) => {
                commitRange(event.target.value, rangeEnd);
              }}
            />
          </div>
          <div className={styles.rangePart}>
            <label className={styles.rangeLabel} htmlFor={endId}>
              止
            </label>
            <input
              id={endId}
              className={styles.control}
              type="date"
              value={rangeEnd}
              onChange={(event) => {
                commitRange(rangeStart, event.target.value);
              }}
            />
          </div>
        </div>
      ) : null}

      {kind === 'text' ? (
        <>
          <label className="visually-hidden" htmlFor={textId}>
            {legend}文字说明
          </label>
          <input
            id={textId}
            className={styles.control}
            type="text"
            value={value.kind === 'text' ? value.text : ''}
            placeholder={textPlaceholder}
            onChange={(event) => {
              onChange(textDateValue(event.target.value));
            }}
          />
          <p className={styles.hint}>文字时限不参与逾期计算，只按原文保留与显示。</p>
        </>
      ) : null}

      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </fieldset>
  );
}
