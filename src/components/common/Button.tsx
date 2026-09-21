import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

/**
 * Buttons.
 *
 * `variant` encodes intent, and intent decides colour — not the other way round. `danger` is the
 * only variant that is red, which is why the legacy prototype's "导出 Excel" and "清空全部数据"
 * buttons, both `background: var(--primary)`, could not be told apart at a glance.
 *
 * `iconOnly` requires `aria-label`; the type makes it impossible to omit.
 */

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>;

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'honor';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps extends BaseProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly busy?: boolean;
}

interface LabelledButtonProps extends CommonProps {
  readonly children: ReactNode;
  readonly iconOnly?: false;
  readonly icon?: ReactNode;
}

interface IconOnlyButtonProps extends CommonProps {
  readonly iconOnly: true;
  readonly icon: ReactNode;
  /** Mandatory for an icon-only control (WCAG 4.1.2). */
  readonly 'aria-label': string;
  readonly children?: never;
}

export type ButtonProps = LabelledButtonProps | IconOnlyButtonProps;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    busy = false,
    icon,
    iconOnly = false,
    children,
    disabled,
    type = 'button',
    ...rest
  } = props as Omit<LabelledButtonProps, 'iconOnly'> & { iconOnly?: boolean | undefined };

  const className = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : '',
    iconOnly ? styles.iconOnly : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={className}
      // A busy button is disabled so a second submission cannot be queued behind the first.
      disabled={disabled === true || busy}
      aria-busy={busy ? true : undefined}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {iconOnly ? null : <span className={styles.label}>{children}</span>}
    </button>
  );
});
