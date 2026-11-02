import { Button, Dialog, Select, Tooltip } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isTemporal, type SpecField } from '../api/spec'
import { grains, type Grain } from '../lib/builder'
import { drillProblem, finerGrains, levelLabel, maxDrillLevels, within, type DrillLevel, type Grouping } from '../lib/drill'
import { Icon } from './Icon'
import './drill.css'

/**
 * Sets the levels a viewer drills down below one dimension of a chart: the
 * dimension itself first, then a level to a line. With no level left, the
 * chart is not drilled. See .agents/design/chart-dashboard.md §2.10.
 */
export function DrillDialog({ first, levels, others, fields, onDone, onCancel }: {
  /** The dimension drilled down: the first level. */
  first: Grouping
  levels: DrillLevel[] | undefined
  /** The chart's other dimensions, which no level may repeat. */
  others: Grouping[]
  fields: SpecField[]
  onDone: (levels: DrillLevel[] | undefined) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  // A date not yet drilled starts down its finer grains, which can be taken off.
  const [draft, setDraft] = useState<Grouping[]>(() => levels?.map(({ field, grain }) => ({ field, ...(grain ? { grain } : {}) })) ?? finerGrains(first.grain).map((grain) => ({ field: first.field, grain })))
  const available = fields.filter((field) => !field.hidden && field.role === 'dimension')
  const problem = drillProblem(first, draft, others, fields)
  const move = (index: number) => setDraft((current) => {
    if (index < 1) return current
    const next = [...current]
    ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
    return next
  })
  const patch = (index: number, level: Grouping) => setDraft((current) => current.map((other, at) => (at === index ? level : other)))
  // A date goes on down from the level above it where it is the same field; any other starts by month.
  const leveled = (key: string, above: Grouping): Grouping => {
    const field = fields.find((candidate) => candidate.key === key)
    if (!field || !isTemporal(field.type)) return { field: key }
    return { field: key, grain: (key === above.field ? finerGrains(above.grain)[0] : undefined) ?? 'month' }
  }
  const add = (key: string) => setDraft((current) => (current.length >= maxDrillLevels ? current : [...current, leveled(key, current.at(-1) ?? first)]))
  const named = (level: Grouping) => levelLabel(level, fields, t)
  return (
    <Dialog open title={t('drill.titleOf', { name: named(first) })} width={560} onClose={onCancel}
      actions={<><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={Boolean(problem)} onClick={() => onDone(draft.length ? draft.map((level) => ({ ...level, label: named(level) })) : undefined)}>{t('common.confirm')}</Button></>}>
      <div className="drill-dialog">
        <p className="note small">{t('drill.hint')}</p>
        <ol className="drill-levels">
          <li className="drill-level">
            <span className="drill-level-index">1</span>
            <span className="drill-level-first">{named(first)}</span>
          </li>
          {draft.map((level, index) => {
            const field = fields.find((candidate) => candidate.key === level.field)
            const above = index === 0 ? first : draft[index - 1]!
            const name = named(level)
            return (
              <li key={index} className="drill-level">
                <span className="drill-level-index">{index + 2}</span>
                <Select block search searchBy="label" size="sm" aria-label={t('drill.levelField', { n: index + 2 })} value={level.field}
                  options={available.map((candidate) => ({ value: candidate.key, label: candidate.label }))}
                  onChange={(key) => patch(index, leveled(key, above))} />
                {field && isTemporal(field.type) ? (
                  <Select<Grain> size="sm" aria-label={t('drill.levelGrain', { n: index + 2 })} value={level.grain ?? 'month'}
                    options={grains.map((grain) => ({ value: grain, label: t(`explore.grains.${grain}`), disabled: level.field === above.field && !within(above.grain, grain) }))}
                    onChange={(grain) => patch(index, { field: level.field, grain })} />
                ) : <span />}
                <span className="drill-level-actions">
                  <Tooltip title={t('drill.moveUp', { name })}><button type="button" className="wb-icon-button drill-move-up" aria-label={t('drill.moveUp', { name })} disabled={index === 0} onClick={() => move(index)}><Icon name="chevronDown" size={14} /></button></Tooltip>
                  <Tooltip title={t('drill.remove', { name })}><button type="button" className="wb-icon-button" aria-label={t('drill.remove', { name })} onClick={() => setDraft((current) => current.filter((_, at) => at !== index))}><Icon name="close" size={14} /></button></Tooltip>
                </span>
              </li>
            )
          })}
        </ol>
        {/* Remounted after each pick so it is empty again, ready for the next. */}
        <Select key={draft.length} block search searchBy="label" disabled={draft.length >= maxDrillLevels} aria-label={t('drill.add')} placeholder={t('drill.add')} value={undefined}
          options={available.map((field) => ({ value: field.key, label: field.label }))} onChange={add} />
        {draft.length >= maxDrillLevels && <span className="note small">{t('drill.limit', { count: maxDrillLevels + 1 })}</span>}
        {/* Taking every level off a drill there was is how it is let go of. */}
        {problem ? <p className="note small warning" role="status">{t(`drill.problems.${problem}`)}</p> : !draft.length && Boolean(levels?.length) && <p className="note small" role="status">{t('drill.none')}</p>}
      </div>
    </Dialog>
  )
}
