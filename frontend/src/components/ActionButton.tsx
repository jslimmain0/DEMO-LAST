import type { ButtonHTMLAttributes } from 'react'

/** Explicit action colors supplement native controls without overriding existing inline buttons. */
export function ActionButton({ variant = 'secondary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button {...props} type={type} className={`fl-action-button fl-action-button--${variant} ${className}`} />
}
