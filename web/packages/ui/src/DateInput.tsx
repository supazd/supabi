import { cn } from 'cn'
import { endOfWeek, format, parse, startOfWeek } from 'date-fns'
import { enUS, zhCN } from 'date-fns/locale'
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { fieldClass, type Size } from './fieldBox'
import { useLocale, useStrings, type Locale } from './locale'
import { Calendar } from './shadcn/calendar.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './shadcn/popover.tsx'

const pattern = 'yyyy-MM-dd'
const toDate = (day: string | undefined) => (day ? parse(day, pattern, new Date()) : undefined)
const toDay = (date: Date | undefined) => (date ? format(date, pattern) : undefined)
const calendarLocales = { 'zh-CN': zhCN, 'en-US': enUS } satisfies Record<Locale, unknown>

/** The box a calendar opens from, with a cross that empties it while it holds a day. */
function DateBox({ size, disabled, filled, onClear, id, ariaLabel, open, onOpenChange, calendar, children }: {
  size: Size
  disabled?: boolean
  filled: boolean
  onClear: () => void
  id?: string
  ariaLabel?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  calendar: ReactNode
  children: ReactNode
}) {
  const t = useStrings()
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <span className={cn('lb-date-input', fieldClass(size), 'tw:gap-1 tw:p-0', disabled && 'tw:opacity-50')}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            aria-label={ariaLabel}
            disabled={disabled}
            className="tw:flex tw:h-full tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-center tw:gap-1.5 tw:rounded-[inherit] tw:border-0 tw:bg-transparent tw:pl-2.5 tw:text-left tw:outline-none tw:focus-visible:ring-3 tw:focus-visible:ring-ring/50 tw:disabled:cursor-not-allowed"
          >
            {children}
          </button>
        </PopoverTrigger>
        {filled && !disabled ? (
          <button type="button" aria-label={t.clear} className="tw:mr-2 tw:inline-flex tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:text-foreground" onClick={onClear}>
            <XIcon className="tw:size-3.5" aria-hidden="true" />
          </button>
        ) : (
          <CalendarIcon className="tw:mr-2 tw:size-3.5 tw:text-muted-foreground" aria-hidden="true" />
        )}
      </span>
      <PopoverContent align="start" className="tw:w-auto tw:p-0">
        {calendar}
      </PopoverContent>
    </Popover>
  )
}

const Day = ({ value, placeholder }: { value: string | undefined; placeholder: string }) => (
  <span className={cn('tw:tabular-nums tw:whitespace-nowrap', !value && 'tw:text-muted-foreground')}>{value ?? placeholder}</span>
)

export interface DateInputProps {
  /** A day as YYYY-MM-DD. */
  value: string | undefined
  onChange: (value: string | undefined) => void
  placeholder?: string
  size?: Size
  disabled?: boolean
  /** Whether the day can be taken away, leaving none. Defaults to true. */
  clearable?: boolean
  id?: string
  'aria-label'?: string
}

/** A calendar for choosing one day. */
export function DateInput({ value, onChange, placeholder, size = 'md', disabled, clearable = true, id, 'aria-label': ariaLabel }: DateInputProps) {
  const t = useStrings()
  const locale = calendarLocales[useLocale()]
  const [open, setOpen] = useState(false)
  const date = toDate(value)
  return (
    <DateBox
      size={size}
      disabled={disabled}
      filled={clearable && Boolean(value)}
      onClear={() => onChange(undefined)}
      id={id}
      ariaLabel={ariaLabel}
      open={open}
      onOpenChange={setOpen}
      calendar={
        <Calendar
          mode="single"
          required={!clearable}
          locale={locale}
          selected={date}
          defaultMonth={date}
          onSelect={(next: Date | undefined) => {
            onChange(toDay(next))
            setOpen(false)
          }}
        />
      }
    >
      <Day value={value} placeholder={placeholder ?? t.chooseDate} />
    </DateBox>
  )
}

export interface DateRangeInputProps {
  /** The first and the last day, both included, as YYYY-MM-DD. Either may be left open. */
  value: [string | undefined, string | undefined]
  onChange: (value: [string | undefined, string | undefined]) => void
  placeholder?: [string, string]
  size?: Size
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

/** A calendar for choosing a run of days. */
export function DateRangeInput({ value, onChange, placeholder, size = 'md', disabled, id, 'aria-label': ariaLabel }: DateRangeInputProps) {
  const t = useStrings()
  const locale = calendarLocales[useLocale()]
  const [open, setOpen] = useState(false)
  // Days chosen since the calendar opened: the second ends the choice.
  const picks = useRef(0)
  const [start, end] = value
  const from = toDate(start)
  return (
    <DateBox
      size={size}
      disabled={disabled}
      filled={Boolean(start || end)}
      onClear={() => onChange([undefined, undefined])}
      id={id}
      ariaLabel={ariaLabel}
      open={open}
      onOpenChange={(next) => {
        picks.current = 0
        setOpen(next)
      }}
      calendar={
        <Calendar
          mode="range"
          locale={locale}
          numberOfMonths={2}
          selected={{ from, to: toDate(end) }}
          defaultMonth={from}
          onSelect={(next) => {
            onChange([toDay(next?.from), toDay(next?.to)])
            picks.current += 1
            if (picks.current >= 2) setOpen(false)
          }}
        />
      }
    >
      <Day value={start} placeholder={placeholder?.[0] ?? t.startDate} />
      <span className="tw:text-muted-foreground" aria-hidden="true">→</span>
      <Day value={end} placeholder={placeholder?.[1] ?? t.endDate} />
    </DateBox>
  )
}

/** A calendar laid open in a panel, for choosing one day. */
export function DayCalendar({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const locale = calendarLocales[useLocale()]
  const date = toDate(value)
  return <Calendar mode="single" locale={locale} selected={date} defaultMonth={date} onSelect={(next) => onChange(toDay(next))} />
}

/** A calendar laid open in a panel, two months side by side, for choosing a run of days. */
export function RangeCalendar({ value, onChange }: { value: [string | undefined, string | undefined]; onChange: (value: [string | undefined, string | undefined]) => void }) {
  const locale = calendarLocales[useLocale()]
  const [start, end] = value
  // With nothing chosen, this month is the second of the two: ranges mostly look back.
  const [shown] = useState(() => toDate(start) ?? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
  return <Calendar mode="range" locale={locale} numberOfMonths={2} selected={{ from: toDate(start), to: toDate(end) }} defaultMonth={shown} onSelect={(next) => onChange([toDay(next?.from), toDay(next?.to)])} />
}

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * A calendar laid open in a panel, two months side by side, for choosing a run
 * of whole weeks. The first click picks the week of the day clicked; the second
 * stretches the run to the week of its day. Weeks start on `weekStart`, an ISO
 * weekday from 1 Monday to 7 Sunday.
 */
export function WeekRangeCalendar({ value, weekStart, onChange }: { value: [string | undefined, string | undefined]; weekStart: number; onChange: (value: [string | undefined, string | undefined]) => void }) {
  const locale = calendarLocales[useLocale()]
  const weekStartsOn = (weekStart % 7) as Weekday
  const [start, end] = value
  const [shown] = useState(() => toDate(start) ?? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
  // The first week of a run still being chosen.
  const anchor = useRef<Date | undefined>(undefined)
  const pick = (day: Date) => {
    const first = startOfWeek(day, { weekStartsOn })
    const from = anchor.current
    if (!from) {
      anchor.current = first
      onChange([toDay(first), toDay(endOfWeek(day, { weekStartsOn }))])
      return
    }
    anchor.current = undefined
    onChange(first < from ? [toDay(first), toDay(endOfWeek(from, { weekStartsOn }))] : [toDay(from), toDay(endOfWeek(day, { weekStartsOn }))])
  }
  return <Calendar mode="range" locale={locale} weekStartsOn={weekStartsOn} numberOfMonths={2} selected={{ from: toDate(start), to: toDate(end) }} defaultMonth={shown} onSelect={(_, day) => pick(day)} />
}

/**
 * Two years of months laid open in a panel, for choosing a run of months,
 * each as YYYY-MM. The first click picks a month; the second ends the run.
 */
export function MonthRangeCalendar({ value, onChange }: { value: [string | undefined, string | undefined]; onChange: (value: [string | undefined, string | undefined]) => void }) {
  const code = useLocale()
  const t = useStrings()
  const [start, end] = value
  // With nothing chosen, this year is the second of the two: ranges mostly look back.
  const [year, setYear] = useState(() => (start ? Number(start.slice(0, 4)) : new Date().getFullYear() - 1))
  const anchor = useRef<string | undefined>(undefined)
  const now = format(new Date(), 'yyyy-MM')
  const pick = (month: string) => {
    const from = anchor.current
    anchor.current = from ? undefined : month
    onChange(!from ? [month, month] : month < from ? [month, from] : [from, month])
  }
  const nav = (step: number, label: string) => (
    <button type="button" aria-label={label} onClick={() => setYear(year + step)} className="tw:inline-flex tw:size-7 tw:cursor-pointer tw:items-center tw:justify-center tw:rounded-md tw:border-0 tw:bg-transparent tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground">
      {step < 0 ? <ChevronLeftIcon className="tw:size-4" aria-hidden="true" /> : <ChevronRightIcon className="tw:size-4" aria-hidden="true" />}
    </button>
  )
  return (
    <div className="lb-month-range tw:flex tw:flex-col tw:gap-4 tw:p-2 tw:md:flex-row tw:md:gap-6">
      {[year, year + 1].map((shownYear, index) => (
        <div key={shownYear} className="tw:flex tw:flex-col tw:gap-2">
          <div className="tw:flex tw:h-7 tw:items-center tw:justify-between">
            {index === 0 ? nav(-1, t.previousYear) : <span className="tw:size-7" />}
            <span className="tw:text-sm tw:font-medium tw:tabular-nums">{shownYear}</span>
            {index === 1 ? nav(1, t.nextYear) : <span className="tw:size-7" />}
          </div>
          <div className="tw:grid tw:grid-cols-3 tw:gap-y-1" role="group" aria-label={String(shownYear)}>
            {Array.from({ length: 12 }, (_, m) => {
              const month = `${shownYear}-${String(m + 1).padStart(2, '0')}`
              const date = new Date(shownYear, m, 1)
              const edge = month === start || month === end
              const inside = Boolean(start && end && month > start && month < end)
              return (
                <button
                  key={month}
                  type="button"
                  aria-label={date.toLocaleString(code, { year: 'numeric', month: 'long' })}
                  aria-pressed={edge || inside}
                  onClick={() => pick(month)}
                  className={cn(
                    'tw:h-8 tw:w-16 tw:cursor-pointer tw:border-0 tw:text-sm tw:tabular-nums',
                    edge ? 'tw:rounded-md tw:bg-primary tw:text-primary-foreground' : inside ? 'tw:bg-muted tw:text-foreground' : 'tw:rounded-md tw:bg-transparent tw:hover:bg-muted',
                    month === now && !edge && 'tw:font-semibold tw:text-primary',
                  )}
                >
                  {date.toLocaleString(code, { month: 'short' })}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
