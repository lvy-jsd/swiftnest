import type { HTMLAttributes } from 'react';

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'success' | 'waiting' | 'danger' | 'accent';
  dot?: boolean;
};

export function Pill({ tone = 'neutral', dot = false, className = '', children, ...props }: PillProps) {
  return (
    <span className={`pill pill--${tone} ${className}`} {...props}>
      {dot && <span className="pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
