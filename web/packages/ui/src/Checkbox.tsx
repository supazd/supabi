import type { ReactNode } from 'react'
import { Checkbox as BaseCheckbox } from './shadcn/checkbox.tsx'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  children?: ReactNode
  'aria-label'?: string
}

/** A single on/off choice with its label. */
export function Checkbox({ checked, onChange, disabled, children, 'aria-label': ariaLabel }: CheckboxProps) {
  return (
    <label className="lb-checkbox tw:inline-flex tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:has-disabled:cursor-not-allowed tw:has-disabled:opacity-60">
      <BaseCheckbox checked={checked} disabled={disabled} aria-label={ariaLabel} onCheckedChange={(next) => onChange(next === true)} />
      {children !== undefined && children !== null && <span className="lb-checkbox-label tw:min-w-0">{children}</span>}
    </label>
  )
}
