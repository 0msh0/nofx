import * as React from 'react'
import { cn } from '../../lib/cn'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'flex h-10 w-full rounded-sm px-3 py-2 text-sm',
          'bg-(--panel-bg) border border-(--panel-border)',
          'text-(--text-primary) focus:outline-hidden focus:border-[#E0483B] focus:ring-1 focus:ring-[rgba(224,72,59,0.18)]',
          className
        )}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'
