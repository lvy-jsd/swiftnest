import { Button, type ButtonProps } from './Button';

export type IconButtonProps = Omit<ButtonProps, 'aria-label'> & { 'aria-label': string };

export function IconButton({ variant = 'ghost', className = '', children, ...props }: IconButtonProps) {
  return (
    <Button variant={variant} className={`icon-button ${className}`} {...props}>
      <span className="icon-button__icon" aria-hidden="true">
        {children}
      </span>
    </Button>
  );
}
