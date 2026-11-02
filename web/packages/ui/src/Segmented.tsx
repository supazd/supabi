import { cn } from 'cn'
import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from './shadcn/toggle-group.tsx'

export interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode; disabled?: boolean }[]
  /** Stretch to the width of the container, the options sharing it equally. */
  block?: boolean
  'aria-label'?: string
}

/** A few choices side by side, one of them taken: for a choice that changes what is shown below it. */
export function Segmented<T extends string>({ value, onChange, options, block, 'aria-label': ariaLabel }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      spacing={0}
      aria-label={ariaLabel}
      value={value}
      // Choosing the taken option again would leave none taken.
      onValueChange={(next) => next && onChange(next as T)}
      className={cn('lb-segmented tw:gap-0.5 tw:bg-muted tw:p-0.5', block && 'tw:w-full')}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          size="sm"
          className={cn('tw:rounded-md! tw:text-muted-foreground tw:hover:bg-transparent tw:data-[state=on]:bg-background tw:data-[state=on]:text-foreground tw:data-[state=on]:shadow-sm tw:dark:data-[state=on]:bg-input', block && 'tw:flex-1')}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
