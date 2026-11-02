import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { Combobox } from './Combobox'
import { fieldClass, type Size } from './fieldBox'
import { useStrings } from './locale'
import type { SelectOption } from './Select'

export interface MultiSelectProps<T extends string | number> {
  value: T[]
  options: SelectOption<T>[]
  onChange: (value: T[]) => void
  /**
   * Called with what is typed, for options that are looked up as the user
   * types. The options given are then shown as they are, not narrowed here.
   */
  onSearch?: (text: string) => void
  loading?: boolean
  placeholder?: string
  size?: Size
  /** Show every selected value and grow vertically as chips wrap. */
  wrap?: boolean
  /** Keeps at least one value chosen: nothing empties the box, and the last value cannot be taken away. */
  required?: boolean
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

/** How many chosen values the box names before it counts the rest. */
const named = 2
const minHeights = { sm: 'tw:min-h-6', md: 'tw:min-h-8', lg: 'tw:min-h-10' } as const

/** Dropdown for choosing several values. The order of selection is kept. */
export function MultiSelect<T extends string | number>({ value, options, onChange, onSearch, loading, placeholder, size = 'md', wrap = false, required = false, disabled, id, 'aria-label': ariaLabel }: MultiSelectProps<T>) {
  const t = useStrings()
  // A value that is chosen but not among the options, as with options looked up by search, is shown as itself.
  const labelOf = (item: T) => options.find((option) => option.value === item)?.label ?? String(item)
  const remove = (item: T) => onChange(value.filter((other) => other !== item))
  const removable = !disabled && !(required && value.length <= 1)
  const chip = cn('tw:inline-flex tw:shrink-0 tw:items-center tw:gap-0.5 tw:rounded-[5px] tw:bg-secondary tw:px-1.5 tw:text-xs tw:leading-5 tw:font-medium tw:ring-1 tw:ring-inset tw:ring-border', wrap ? 'tw:max-w-full tw:min-w-0' : 'tw:max-w-40')
  return (
    <Combobox<T>
      id={id}
      aria-label={ariaLabel}
      className={cn('lb-multi-select', fieldClass(size, { block: true }), wrap && ['tw:h-auto tw:py-1', minHeights[size]])}
      options={options}
      multiple
      wrap={wrap}
      onSearch={onSearch}
      loading={loading}
      disabled={disabled}
      isChosen={(item) => value.includes(item)}
      onPick={(item) => {
        if (value.includes(item) && !removable) return
        onChange(value.includes(item) ? value.filter((other) => other !== item) : [...value, item])
      }}
      end={
        value.length > 0 && !disabled && !required ? (
          <button
            type="button"
            aria-label={t.clear}
            className="tw:inline-flex tw:size-4 tw:cursor-pointer tw:items-center tw:justify-center tw:rounded-full tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:text-foreground"
            // Emptying the box is not a click that opens it.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onChange([])
            }}
          >
            <XIcon className="tw:size-3.5" aria-hidden="true" />
          </button>
        ) : undefined
      }
    >
      {value.length === 0 && <span className="tw:truncate tw:text-muted-foreground">{placeholder}</span>}
      {(wrap ? value : value.slice(0, named)).map((item) => (
        <span key={String(item)} className={chip}>
          <span className={wrap ? "tw:min-w-0 tw:whitespace-normal tw:break-all" : "tw:truncate"}>{labelOf(item)}</span>
          {removable && (
            <button
              type="button"
              aria-label={`${t.remove} ${labelOf(item)}`}
              className="tw:inline-flex tw:shrink-0 tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:text-foreground"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                remove(item)
              }}
            >
              <XIcon className="tw:size-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {!wrap && value.length > named && <span className={chip}>+{value.length - named}</span>}
    </Combobox>
  )
}
