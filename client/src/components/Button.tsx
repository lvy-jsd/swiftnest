import type { ButtonHTMLAttributes } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; iconOnly?: boolean };

export function Button({ variant = "secondary", iconOnly = false, className = "", type = "button", ...props }: ButtonProps) {
  return <button type={type} className={`button button--${variant}${iconOnly ? " button--icon" : ""} ${className}`} {...props} />;
}
