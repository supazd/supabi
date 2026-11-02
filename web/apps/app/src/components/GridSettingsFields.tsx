import { Button, Checkbox, Field, Input, Tooltip } from '@supabi/ui'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultGridSettings, gridSettingLimits, type GridSettings } from '../lib/layout'
import { Icon } from './Icon'

type NumericSetting = keyof typeof gridSettingLimits
export type GridSettingsInput = Record<NumericSetting, string> & { autoCompact: boolean }

export function gridSettingsInput(value: GridSettings): GridSettingsInput {
  return { columns: String(value.columns), rowHeight: String(value.rowHeight), columnGap: String(value.columnGap), rowGap: String(value.rowGap), containerGap: String(value.containerGap), autoCompact: value.autoCompact }
}

/** Parse only when Apply is clicked, including the input that still has focus. */
export function parseGridSettings(value: GridSettingsInput, fallback: GridSettings): GridSettings {
  const result = { ...fallback, autoCompact: value.autoCompact }
  for (const key of Object.keys(gridSettingLimits) as NumericSetting[]) {
    const { min, max, step } = gridSettingLimits[key]
    const parsed = value[key].trim() ? Number(value[key]) : NaN
    result[key] = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed / step) * step)) : fallback[key]
  }
  return result
}

function ResetSetting({ label, onReset }: { label: string; onReset: () => void }) {
  const { t } = useTranslation()
  const title = t('dashboard.resetGridSetting', { name: label })
  return <Tooltip title={title}><Button size="sm" variant="ghost" icon={<Icon name="undo" size={14} />} aria-label={title} onClick={onReset} /></Tooltip>
}

function GridNumberField({ label, value, setting, onChange }: { label: string; value: string; setting: NumericSetting; onChange: (value: string) => void }) {
  const id = useId()
  const changed = !value.trim() || Number(value) !== defaultGridSettings[setting]
  return <Field label={label} htmlFor={id}><div className="dashboard-setting-control">
    <Input id={id} type="number" value={value} onChange={onChange} {...gridSettingLimits[setting]} />
    <span className="dashboard-setting-reset">{changed && <ResetSetting label={label} onReset={() => onChange(String(defaultGridSettings[setting]))} />}</span>
  </div></Field>
}

export function GridSettingsFields({ value, onChange }: { value: GridSettingsInput; onChange: (value: GridSettingsInput) => void }) {
  const { t } = useTranslation()
  const labels = { columns: 'gridColumnCount', rowHeight: 'gridRowHeight', columnGap: 'gridColumnGap', rowGap: 'gridRowGap', containerGap: 'gridContainerGap' } as const
  return <>
    <div className="dashboard-size-fields dashboard-grid-settings">
      {(Object.keys(labels) as NumericSetting[]).map((key) => <GridNumberField key={key} label={t(`dashboard.${labels[key]}`)} setting={key} value={value[key]} onChange={(next) => onChange({ ...value, [key]: next })} />)}
    </div>
    <div className="dashboard-setting-control"><Checkbox checked={value.autoCompact} onChange={(autoCompact) => onChange({ ...value, autoCompact })}>{t('dashboard.gridAutoCompact')}</Checkbox>
      <span className="dashboard-setting-reset">{value.autoCompact !== defaultGridSettings.autoCompact && <ResetSetting label={t('dashboard.gridAutoCompact')} onReset={() => onChange({ ...value, autoCompact: defaultGridSettings.autoCompact })} />}</span>
    </div>
  </>
}
