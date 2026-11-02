import { cn } from 'cn'
import { Loader2Icon } from 'lucide-react'
import type { MouseEventHandler, ReactNode, Ref } from 'react'
import { Button as BaseButton } from './shadcn/button.tsx'

export interface ButtonProps {
  /** primary: the main action of a view. secondary: everything else. ghost: low-emphasis, no border. */
  variant?: 'primary' | 'secondary' | 'ghost'
  /** Marks a destructive action. */
  danger?: boolean
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  /** Shows a spinner and ignores clicks. */
  loading?: boolean
  icon?: ReactNode
  type?: 'button' | 'submit'
  onClick?: MouseEventHandler<HTMLElement>
  children?: ReactNode
  /** Required when the button has an icon and no text. */
  'aria-label'?: string
  ref?: Ref<HTMLButtonElement>
}

const variants = { primary: 'default', secondary: 'outline', ghost: 'ghost' } as const
const sizes = { sm: 'sm', md: 'default', lg: 'lg' } as const
const iconSizes = { sm: 'icon-sm', md: 'icon', lg: 'icon-lg' } as const
// The heights the product's layouts were drawn for: 24, 32 and 40 pixels.
const heights = { sm: 'tw:h-6', md: 'tw:h-8', lg: 'tw:h-10' } as const
const iconHeights = { sm: 'tw:size-6', md: 'tw:size-8', lg: 'tw:size-10' } as const

// A raised edge for the buttons that are boxes, so they read as pressable on a flat page.
const variantClass = {
  primary: 'tw:shadow-[var(--lb-shadow-xs),inset_0_1px_0_rgb(255_255_255/0.14)] tw:hover:bg-primary/90 tw:active:bg-primary',
  secondary: 'tw:shadow-xs tw:hover:border-[color-mix(in_srgb,var(--foreground)_18%,var(--border))]',
  ghost: '',
} as const

const dangerClass = {
  primary: 'tw:bg-destructive tw:text-white tw:hover:bg-destructive/85',
  secondary: 'tw:border-destructive/40 tw:text-destructive tw:hover:border-destructive tw:hover:text-destructive',
  ghost: 'tw:text-destructive tw:hover:bg-destructive/10 tw:hover:text-destructive',
} as const

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  danger,
  disabled,
  loading,
  icon,
  onClick,
  children,
  'aria-label': ariaLabel,
  ref,
}: ButtonProps) {
  const iconOnly = children === undefined || children === null || children === false
  const square = iconOnly && Boolean(icon || loading)
  return (
    <BaseButton
      ref={ref}
      type={type}
      variant={variants[variant]}
      size={square ? iconSizes[size] : sizes[size]}
      className={cn('lb-button', square ? iconHeights[size] : heights[size], variantClass[variant], danger && dangerClass[variant])}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {(loading || icon) && <span className="lb-button-icon tw:inline-flex">{loading ? <Loader2Icon className="tw:animate-spin" aria-hidden="true" /> : icon}</span>}
      {!iconOnly && <span className="lb-button-label">{children}</span>}
    </BaseButton>
  )
}
