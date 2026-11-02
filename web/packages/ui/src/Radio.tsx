import type { ReactNode } from 'react'

export interface RadioProps {
  checked: boolean
  /** Called when it is chosen; a radio is not unchosen by clicking it again. */
  onChange: () => void
  disabled?: boolean
  children?: ReactNode
  'aria-label'?: string
}

/**
 * One choice among several, of which only one can be taken. A native radio
 * drawn like shadcn's: its RadioGroup wants all the choices at once, and a
 * caller here renders them one at a time.
 */
export function Radio({ checked, onChange, disabled, children, 'aria-label': ariaLabel }: RadioProps) {
  return (
    <label className="lb-radio tw:inline-flex tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:has-disabled:cursor-not-allowed tw:has-disabled:opacity-60">
      <input
        type="radio"
        data-slot="radio"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={() => onChange()}
        className="tw:peer tw:m-0 tw:size-4 tw:shrink-0 tw:cursor-[inherit] tw:appearance-none tw:rounded-full tw:border tw:border-input tw:bg-background tw:transition-[border] tw:outline-none tw:checked:border-[5px] tw:checked:border-primary tw:focus-visible:ring-3 tw:focus-visible:ring-ring/50 tw:dark:bg-input/30"
      />
      {children !== undefined && children !== null && <span className="lb-radio-label tw:min-w-0">{children}</span>}
    </label>
  )
}
