import { Select } from '@supabi/ui'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { SpecField } from '../api/spec'
import { aggLabel } from '../lib/aggregations'
import { dynamicSelection, type DynamicField, type DynamicOption, type DynamicSelections } from '../lib/dynamics'
import './dynamics.css'

export function dynamicOptionLabel(option: DynamicOption, fields: SpecField[], t: TFunction): string {
  if (option.label) return option.label
  const field = fields.find((field) => field.key === option.field)
  const name = field?.label ?? option.field
  if (option.grain) return `${name} · ${t(`explore.grains.${option.grain}`)}`
  if (option.agg) return aggLabel(option.agg, name)
  return name
}

/** The same compact selectors appear above the chart in the editor and dashboard. */
export function DynamicControls({ dynamics, values, onChange, fields = [], disabled = false }: {
  dynamics: DynamicField[]
  values: DynamicSelections
  onChange: (id: string, value: string) => void
  fields?: SpecField[]
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return dynamics.map((dynamic) => (
    <span className="widget-filter dynamic-control" key={dynamic.id}>
      <span className="note small">{dynamic.label}</span>
      <Select size="sm" aria-label={dynamic.label} value={dynamicSelection(dynamic, values)} disabled={disabled}
        options={[
          ...(dynamic.kind === 'dimension' && dynamic.allowEmpty ? [{ value: '', label: t('dynamics.empty') }] : []),
          ...dynamic.options.map((option) => ({ value: option.id, label: dynamicOptionLabel(option, fields, t) })),
        ]}
        onChange={(value) => onChange(dynamic.id, value)} />
    </span>
  ))
}
