import { CaretRightIcon } from '@phosphor-icons/react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

type RowContent = {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  value?: ReactNode;
  chevron?: boolean;
};
export type ListRowProps = RowContent &
  (
    | (Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'value'> & {
        onClick: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>['onClick']>;
      })
    | (Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onClick' | 'value'> & { onClick?: never })
  );

export function ListRow({ icon, title, subtitle, value, chevron = false, className = '', ...props }: ListRowProps) {
  const content = (
    <>
      {icon && (
        <span className="list-row__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="list-row__copy">
        <span className="list-row__title">{title}</span>
        {subtitle && <span className="list-row__subtitle">{subtitle}</span>}
      </span>
      {value !== undefined && <span className="list-row__value">{value}</span>}
      {chevron && <CaretRightIcon size={20} weight="regular" aria-hidden="true" />}
    </>
  );
  const classes = `list-row ${className}`;
  return props.onClick ? (
    <button type="button" className={classes} {...props}>
      {content}
    </button>
  ) : (
    <div className={classes} {...props}>
      {content}
    </div>
  );
}
