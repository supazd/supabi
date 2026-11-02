import { applyFormats, formatCell, type DisplayFormat } from '@supabi/charts'
import { DataTable } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import type { QueryResult } from '../api/client'
import { useFirstWeekDays } from '../auth/session'
import { isNumeric } from '../api/spec'
import { namedColumns } from './ChartView'

/** The rows of a result as they came back: what a table chart is, and what lies behind any other. */
export function ResultRows({ result, formats, hidden, label }: {
  result: QueryResult
  /** The chart's display formats, by output column. */
  formats?: Record<string, DisplayFormat>
  /** Output columns the chart leaves out of what it shows. */
  hidden?: string[]
  label: string
}) {
  const { t, i18n } = useTranslation()
  const firstWeekDays = useFirstWeekDays()
  const columns = applyFormats(namedColumns(result, i18n.language), formats).columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !hidden?.includes(column.name))
  return (
    <DataTable
      aria-label={label}
      rows={result.rows.map((cells) => ({ cells }))}
      rowKey={(_, index) => String(index)}
      pageSize={100}
      empty={t('common.none')}
      columns={columns.map(({ column, index }) => ({
        key: column.name,
        title: column.label ?? column.name,
        // Numbers line up on the right whatever they are for: in a detail table no column is a measure.
        align: column.role === 'measure' || isNumeric(column.type) ? ('right' as const) : ('left' as const),
        render: (row: { cells: unknown[] }) => <span className="tabular">{formatCell(row.cells[index] as never, column, i18n.language, firstWeekDays)}</span>,
      }))}
    />
  )
}
