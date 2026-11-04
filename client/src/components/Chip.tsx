import type { ButtonHTMLAttributes } from 'react';

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> & { selected: boolean };

export function Chip({ selected, className = '', type = 'button', ...props }: ChipProps) {
  return <button type={type} className={`button chip ${className}`} aria-pressed={selected} {...props} />;
}
