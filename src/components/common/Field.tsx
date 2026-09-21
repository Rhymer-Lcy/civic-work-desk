import { useId } from 'react';
import type { ReactNode } from 'react';
import styles from './Field.module.css';

/**
 * Form field wrapper.
 *
 * Every control gets a real `<label for>`, not a placeholder standing in for one (WCAG 3.3.2 —
 * the legacy form relied on placeholders such as "如：市贸促会" as the only hint, which vanish on
 * input and are not exposed as names by every screen reader).
 *
 * Errors and hints are wired through `aria-describedby`, and an error also sets
 * `aria-invalid`, so the message is announced rather than merely coloured red (WCAG 1.4.1).
 */

export interface FieldProps {
  readonly label: string;
  readonly required?: boolean | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  /** Receives the ids to wire onto the control. */
  readonly children: (ids: FieldIds) => ReactNode;
}

export interface FieldIds {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

export function Field({ label, required = false, hint, error, children }: FieldProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      {/*
        The asterisk is decorative and the requirement is carried by the control's own `required`
        / `aria-required` attributes, which assistive technology announces natively. Putting
        "（必填）" inside the label instead would append it to every control's accessible name —
        verbose to hear, and it makes the name unstable as copy changes.
        A form-level note explains the asterisk (WCAG 3.3.2).
      */}
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className={styles.asterisk}>
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy, invalid: error !== undefined, required })}
      {hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} id={errorId}>
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A fieldset for a group of related controls (e.g. a date-kind radio set). */
export function FieldGroup({
  legend,
  hint,
  children,
}: {
  readonly legend: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      <div className={styles.groupBody}>{children}</div>
    </fieldset>
  );
}
