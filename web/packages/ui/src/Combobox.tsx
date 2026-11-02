import { cn } from 'cn'
import { CheckIcon, ChevronDownIcon, Loader2Icon } from 'lucide-react'
import { useState, type ReactNode, type Ref } from 'react'
import { useStrings } from './locale'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './shadcn/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './shadcn/popover.tsx'
import type { SelectOption } from './Select'

/**
 * A list to choose from that can be narrowed by typing, under the box it
 * opens from. Not exported: Select and MultiSelect are built on it.
 */
export interface ComboboxProps<T extends string | number> {
  options: SelectOption<T>[]
  isChosen: (value: T) => boolean
  /** Called with the option chosen. Choosing one closes the list unless several can be chosen. */
  onPick: (value: T) => void
  multiple?: boolean
  /** Let selected content flow onto additional lines. */
  wrap?: boolean
  /** Narrow by the option's value rather than its label. */
  filterByValue?: boolean
  /** Called with what is typed; the options are then shown as given, not narrowed here. */
  onSearch?: (text: string) => void
  loading?: boolean
  disabled?: boolean
  /** Classes of the box, from fieldClass. */
  className: string
  /** What the box shows. */
  children: ReactNode
  /** Shown at the end of the box, before the arrow, such as a button that empties it. */
  end?: ReactNode
  id?: string
  'aria-label'?: string
}

export function Combobox<T extends string | number>({ options, isChosen, onPick, multiple, wrap, filterByValue, onSearch, loading, disabled, className, children, end, id, 'aria-label': ariaLabel }: ComboboxProps<T>) {
  const t = useStrings()
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<HTMLElement | null>(null)
  const text = (option: SelectOption<T>) => (filterByValue ? String(option.value) : option.label)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onSearch?.('')
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        {/* A div, not a button: the box of a MultiSelect holds buttons of its own. */}
        <div
          ref={setBox as Ref<HTMLDivElement>}
          id={id}
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-disabled={disabled || undefined}
          aria-busy={(loading && !disabled) || undefined}
          className={cn(className, 'tw:cursor-pointer')}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || disabled) return
            if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <span className={cn("tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-1 tw:overflow-hidden", wrap && "tw:flex-wrap")}>{children}</span>
          {end}
          {loading && !disabled ? (
            <Loader2Icon className="tw:size-4 tw:animate-spin tw:text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="tw:size-4 tw:text-muted-foreground" aria-hidden="true" />
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="lb-combobox tw:w-auto tw:max-w-[min(480px,calc(100vw-24px))] tw:min-w-(--radix-popover-trigger-width) tw:gap-0 tw:p-0"
        // The focus goes back to the box, so that choosing from the keyboard can go on from there.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          box?.focus()
        }}
      >
        <Command
          shouldFilter={!onSearch}
          filter={(_value, search, keywords) => ((keywords?.[0] ?? '').toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder={t.search} aria-label={t.search} onValueChange={onSearch} />
          <CommandList aria-multiselectable={multiple || undefined}>
            {loading ? (
              <div className="tw:flex tw:items-center tw:justify-center tw:gap-2 tw:py-6 tw:text-sm tw:text-muted-foreground" role="status">
                <Loader2Icon className="tw:size-4 tw:animate-spin" aria-hidden="true" />
                {t.loading}
              </div>
            ) : (
              <CommandEmpty>{t.noResults}</CommandEmpty>
            )}
            {!loading &&
              options.map((option, index) => (
                <CommandItem
                  key={`${index}:${String(option.value)}`}
                  value={`${index}:${String(option.value)}`}
                  keywords={[text(option)]}
                  disabled={option.disabled}
                  aria-checked={isChosen(option.value)}
                  // CommandItem shows its check on what is chosen.
                  data-checked={isChosen(option.value) ? 'true' : undefined}
                  // Where several can be chosen each option has a box to tick, in place of the check at its end.
                  className={multiple ? 'tw:[&>svg:last-child]:hidden tw:data-[checked=true]:font-normal!' : undefined}
                  onSelect={() => {
                    onPick(option.value)
                    if (!multiple) setOpen(false)
                  }}
                >
                  {multiple && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'tw:flex tw:size-4 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-[4px] tw:border tw:shadow-xs tw:transition-colors',
                        isChosen(option.value) ? 'tw:border-primary tw:bg-primary tw:text-primary-foreground' : 'tw:border-input tw:bg-background',
                      )}
                    >
                      {isChosen(option.value) && <CheckIcon className="tw:size-3" strokeWidth={3} />}
                    </span>
                  )}
                  {option.icon}
                  <span className="tw:min-w-0 tw:flex-1 tw:truncate">{option.label}</span>
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
