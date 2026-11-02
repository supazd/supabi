import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Combobox } from './Combobox'
import { fieldClass, type Size } from './fieldBox'
import { Select as BaseSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from './shadcn/select.tsx'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** A small mark shown before the label, in the list and in the box once chosen. */
  icon?: ReactNode
  disabled?: boolean
}

export interface SelectProps<T extends string | number> {
  value: T | undefined
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  size?: Size
  disabled?: boolean
  /** Stretch to the width of the container. */
  block?: boolean
  /** Without a box of its own, for a choice that sits in a line of other things. */
  plain?: boolean
  /** Typing narrows the options to those whose value has what was typed, for a long list. */
  search?: boolean
  /** Search labels instead of internal values. Defaults to value for compatibility. */
  searchBy?: 'value' | 'label'
  id?: string
  'aria-label'?: string
}

// Radix keys its items by non-empty strings; an option's value may be neither.
const keyOf = (value: string | number) => `v:${typeof value}:${value}`

const Label = ({ option }: { option: SelectOption<string | number> }) => (
  <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-1.5">
    {option.icon}
    <span className="tw:truncate">{option.label}</span>
  </span>
)

const triggerHeights = { sm: 'tw:data-[size=default]:h-6', md: 'tw:data-[size=default]:h-8', lg: 'tw:data-[size=default]:h-10' } as const

/** Single-choice dropdown. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  size = 'md',
  disabled,
  block,
  plain,
  search,
  searchBy = 'value',
  id,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  const chosen = options.find((option) => option.value === value)
  const box = cn('lb-select', fieldClass(size, { block, plain }))

  if (search) {
    return (
      <Combobox<T>
        id={id}
        aria-label={ariaLabel}
        className={box}
        options={options}
        filterByValue={searchBy === 'value'}
        disabled={disabled}
        isChosen={(option) => option === value}
        onPick={onChange}
      >
        {chosen ? <Label option={chosen} /> : <span className="tw:truncate tw:text-muted-foreground">{placeholder}</span>}
      </Combobox>
    )
  }

  return (
    <BaseSelect
      value={value === undefined ? '' : keyOf(value)}
      disabled={disabled}
      onValueChange={(key) => {
        const option = options.find((candidate) => keyOf(candidate.value) === key)
        if (option) onChange(option.value)
      }}
    >
      {/* The trigger's own height rule is keyed by its size and outranks ours, so ours is keyed the same way. */}
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn(box, triggerHeights[size])}>
        <SelectValue placeholder={placeholder}>{chosen && <Label option={chosen} />}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" className="lb-select-list tw:max-w-[min(480px,calc(100vw-24px))]">
        {options.map((option) => (
          <SelectItem key={keyOf(option.value)} value={keyOf(option.value)} disabled={option.disabled}>
            <Label option={option} />
          </SelectItem>
        ))}
      </SelectContent>
    </BaseSelect>
  )
}
