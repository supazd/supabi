import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { quietFocus } from './fieldBox'
import { useStrings } from './locale'
import { Input as BaseInput } from './shadcn/input.tsx'
import { Textarea as BaseTextarea } from './shadcn/textarea.tsx'

export interface InputProps {
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password' | 'number' | 'time'
  min?: number
  max?: number
  step?: number
  placeholder?: string
  disabled?: boolean
  /** Marks the value as not acceptable. */
  invalid?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Shows a cross that empties the field while there is something in it. */
  clearable?: boolean
  /** The most characters it takes; more cannot be typed. */
  maxLength?: number
  /** Shows a value to select and copy, which cannot be changed. */
  readOnly?: boolean
  id?: string
  'aria-label'?: string
}

// The heights the product's layouts were drawn for: 24, 32 and 40 pixels.
const sizes = { sm: 'tw:h-6 tw:px-2 tw:md:text-sm', md: 'tw:h-8', lg: 'tw:h-10 tw:md:text-base' } as const

/** Single-line text. */
export function Input({ value, onChange, type = 'text', min, max, step, placeholder, disabled, invalid, size = 'md', clearable, maxLength, readOnly, id, 'aria-label': ariaLabel }: InputProps) {
  const t = useStrings()
  const field = (
    <BaseInput
      id={id}
      type={type}
      min={min}
      max={max}
      step={step}
      maxLength={maxLength}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      // The password variant has no reveal toggle on purpose: stored passwords are never sent back.
      autoComplete={type === 'password' ? 'new-password' : undefined}
      className={cn(quietFocus, sizes[size], clearable ? 'tw:pr-7' : 'lb-input')}
      onChange={(event) => onChange(event.target.value)}
    />
  )
  if (!clearable) return field
  return (
    <span className="lb-input tw:relative tw:inline-flex tw:w-full tw:min-w-0 tw:items-center">
      {field}
      {value && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t.clear}
          className="tw:absolute tw:right-1.5 tw:inline-flex tw:size-4 tw:cursor-pointer tw:items-center tw:justify-center tw:rounded-full tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:text-foreground"
          onClick={() => onChange('')}
        >
          <XIcon className="tw:size-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

export interface TextAreaProps {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  disabled?: boolean
  maxLength?: number
  id?: string
  'aria-label'?: string
}

/** Multi-line text. Code is written in a CodeEditor instead. */
export function TextArea({ value, onChange, rows = 4, placeholder, disabled, maxLength, id, 'aria-label': ariaLabel }: TextAreaProps) {
  return (
    <BaseTextarea
      id={id}
      value={value}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn('lb-textarea tw:field-sizing-fixed', quietFocus)}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
