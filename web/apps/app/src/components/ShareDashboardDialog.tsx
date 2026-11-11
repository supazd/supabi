import type { Cell } from '@supabi/charts'
import { Button, Checkbox, Dialog, Input, Select, Tooltip } from '@supabi/ui'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Chart } from '../api/client'
import { useAsync } from '../api/useAsync'
import { useWorkspaceTimezone } from '../auth/session'
import type { ChartSpec } from '../lib/builder'
import { hasChoices, type ChoiceSpec, type ViewState } from '../lib/dashboardView'
import { stepText } from '../lib/drill'
import { describeCondition, describeValue, isEmpty, type FilterOp } from '../lib/filters'
import { chartItems, isTabs } from '../lib/layout'
import { widgetName } from '../lib/links'
import { isParamFilter, paramValueSummary } from '../lib/paramFilters'
import { useClipboard } from '../lib/useClipboard'
import { dynamicOptionLabel } from './DynamicControls'
import { ErrorAlert } from './ErrorAlert'
import { filterCaption } from './FilterControl'
import { withinWorkspace } from '../lib/workspaceAddress'

const validities = [1, 7, 30, 90] as const

/** The kinds of condition a share link may carry, each ticked or not as a whole, and the parts of the state each is kept in. */
const shareParts = ['filters', 'chartFilters', 'links', 'selections', 'drill', 'tabs'] as const
type SharePart = (typeof shareParts)[number]
const partKeys: Record<SharePart, (keyof ViewState)[]> = { filters: ['filters'], chartFilters: ['chartFilters', 'useChartFilters'], links: ['links'], selections: ['selections'], drill: ['drill'], tabs: ['page', 'tabs'] }
/** The kinds whose values are data, which whoever opens the link sees. */
const valued: SharePart[] = ['filters', 'chartFilters', 'links', 'drill']

/** A condition in words: a list or a range after its name, anything else as the formula puts it. Cleared, it is no condition at all, whatever its operator. */
function conditionText(label: string, op: FilterOp, value: unknown, t: TFunction): string {
  if (isEmpty(op, value)) return t('dashboard.share.named', { name: label, value: t('filter.any') })
  return ['in', 'not_in', 'time', 'between', 'not_between'].includes(op)
    ? t('dashboard.share.named', { name: filterCaption(label, op, t), value: describeValue(op, value, t) })
    : `${label} ${describeCondition(op, value, t)}`
}

/** What each kind of condition carries, one line for each condition, in words. */
function describeParts(state: ViewState, spec: ChoiceSpec, charts: Chart[], t: TFunction, linkText?: (id: string, value: Cell) => string, zone?: string): Record<SharePart, string[]> {
  const holders = chartItems(spec.layout.items)
  const holder = (id: string) => holders.find((entry) => entry.id === id)
  const nameOf = (id: string) => { const found = holder(id); return found ? widgetName(found, holders, charts) : id }
  const chartOf = (id: string) => charts.find((chart) => chart.id === holder(id)?.chartId)?.spec as unknown as ChartSpec | undefined
  const cell = (value: unknown) => value === null ? t('dashboard.linkNull') : value === '' ? t('dashboard.linkEmpty') : String(value)
  return {
    filters: Object.entries(state.filters ?? {}).map(([id, value]) => {
      const filter = spec.filters?.find((entry) => entry.id === id)
      return filter ? conditionText(filter.label, filter.op, value, t) : id
    }),
    chartFilters: [
      ...Object.entries(state.chartFilters ?? {}).flatMap(([id, values]) => Object.entries(values).map(([filterId, value]) => {
        const filter = chartOf(id)?.filters?.find((entry) => entry.id === filterId)
        if (filter && isParamFilter(filter)) return `${nameOf(id)} · ${t('dashboard.share.named', { name: filter.label ?? filter.param, value: paramValueSummary(value, t, zone) })}`
        return `${nameOf(id)} · ${filter ? conditionText(filter.label ?? filter.field, filter.op, value, t) : filterId}`
      })),
      ...(state.useChartFilters ?? []).map((id) => `${nameOf(id)} · ${t('dashboard.share.ownFilters')}`),
    ],
    links: Object.entries(state.links ?? {}).map(([id, value]) => t('dashboard.share.named', { name: spec.links?.find((link) => link.id === id)?.label ?? id, value: linkText ? linkText(id, value as Cell) : cell(value) })),
    selections: Object.entries(state.selections ?? {}).flatMap(([id, values]) => Object.entries(values).map(([slot, option]) => {
      const dynamic = chartOf(id)?.dynamics?.find((entry) => entry.id === slot)
      const chosen = dynamic?.options.find((entry) => entry.id === option)
      return `${nameOf(id)} · ${t('dashboard.share.named', { name: dynamic?.label ?? slot, value: option === '' ? t('dynamics.empty') : chosen ? dynamicOptionLabel(chosen, [], t) : option })}`
    })),
    // The values clicked on the way down, as the breadcrumb writes them.
    drill: Object.entries(state.drill ?? {}).map(([id, position]) => t('dashboard.share.named', { name: nameOf(id), value: position.steps.map((step) => stepText({ value: step.value as Cell, text: step.text }, t)).join(' › ') })),
    // The page shown, then the tab each tab container shows.
    tabs: [
      ...(state.page ? [t('dashboard.share.page', { name: spec.layout.pages?.find((page) => page.id === state.page)?.name ?? state.page })] : []),
      ...Object.entries(state.tabs ?? {}).map(([id, tabId]) => {
        const tab = spec.layout.items.find((item) => item.id === id && isTabs(item))
        const found = tab && isTabs(tab) ? tab.tabs.find((entry) => entry.id === tabId) : undefined
        return found?.title || charts.find((chart) => chart.id === found?.chartId)?.name || tabId
      }),
    ],
  }
}

/** The address of a dashboard, in the workspace it belongs to, with the conditions of a share link if any. */
export function dashboardLink(dashboardId: string, workspaceId: string | undefined, viewId?: string): string {
  const path = `/dashboards/${encodeURIComponent(dashboardId)}`
  const search = viewId ? `?${new URLSearchParams({ view: viewId })}` : ''
  return `${window.location.origin}${workspaceId ? withinWorkspace(workspaceId, path) : path}${search}`
}

/**
 * Hands out a link to the dashboard, with the conditions in view when the
 * viewer chooses so. The conditions stay on the server and the link names
 * them by an ID; the link grants nothing (.agents/design/chart-dashboard.md 3.10).
 */
export function ShareDashboardDialog({ dashboardId, workspaceId, state, spec, charts, linkText, onClose }: {
  dashboardId: string
  workspaceId?: string
  /** What the viewer has chosen that differs from the dashboard's own. */
  state: ViewState
  /** The dashboard and its charts, to say what is carried in words. */
  spec: ChoiceSpec
  charts: Chart[]
  /** How a link's value is written, as the chart it was clicked in writes it. */
  linkText?: (id: string, value: Cell) => string
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const zone = useWorkspaceTimezone()
  const conditions = hasChoices(state)
  // Not carried unless asked: a link with conditions expires, and shows filter values; the dashboard's address does neither.
  const [carry, setCarry] = useState(false)
  // Once asked, every kind of condition there is goes, unless unticked.
  const present = shareParts.filter((part) => partKeys[part].some((key) => state[key] !== undefined))
  const [untick, setUntick] = useState<SharePart[]>([])
  const ticked = present.filter((part) => !untick.includes(part))
  const carried: ViewState = Object.fromEntries(Object.entries(state).filter(([key]) => ticked.some((part) => partKeys[part].includes(key as keyof ViewState))))
  const carrying = carry && ticked.length > 0
  const described = describeParts(state, spec, charts, t, linkText, zone)
  const [days, setDays] = useState<(typeof validities)[number]>(30)
  const { status: copied, copy: write, reset: forgetCopy } = useClipboard()
  // Kept only once asked for: a link without conditions is just the dashboard's address. The same conditions for as long keep the same link.
  const view = useAsync(
    () => (carrying ? unwrap(api.POST('/dashboards/{id}/views', { params: { path: { id: dashboardId } }, body: { state: carried, validDays: days } })) : Promise.resolve(undefined)),
    [carrying, days, JSON.stringify(carried)],
  )
  const link = !carrying ? dashboardLink(dashboardId, workspaceId) : view.status === 'ok' && view.data ? dashboardLink(dashboardId, workspaceId, view.data.id) : undefined
  const copy = async () => {
    if (link) await write(link)
  }

  return (
    <Dialog open title={t('dashboard.share.title')} width={520} onClose={onClose}
      actions={<><Button onClick={onClose}>{t('common.close')}</Button><Button variant="primary" disabled={!link} onClick={() => void copy()}>{t('dashboard.share.copy')}</Button></>}>
      <div className="share-dialog">
        <p className="note small">{t('dashboard.share.access')}</p>
        {conditions && (
          <div className="share-conditions">
            <Checkbox checked={carry} onChange={(next) => { setCarry(next); forgetCopy() }}>{t('dashboard.share.carry')}</Checkbox>
            {carry && <>
              <ul className="share-parts" aria-label={t('dashboard.share.parts.label')}>
                {present.map((part) => {
                  const lines = described[part]
                  return <li key={part}>
                    <Checkbox checked={ticked.includes(part)} onChange={(next) => { setUntick((current) => next ? current.filter((entry) => entry !== part) : [...current, part]); forgetCopy() }}>{t(`dashboard.share.parts.${part}`)}</Checkbox>
                    <Tooltip title={<div className="tooltip-lines">{lines.map((line, index) => <div key={index}>{line}</div>)}</div>}>
                      <span className={`note small share-part-detail${ticked.includes(part) ? '' : ' off'}`}>{lines.join(t('dashboard.share.parts.separator'))}</span>
                    </Tooltip>
                  </li>
                })}
              </ul>
              {!ticked.length && <p className="note small">{t('dashboard.share.none')}</p>}
              {ticked.length > 0 && <div className="row">
                <span className="note small">{t('dashboard.share.validity')}</span>
                <Select<number> size="sm" aria-label={t('dashboard.share.validity')} value={days} options={validities.map((value) => ({ value, label: t('dashboard.share.days', { count: value }) }))} onChange={(value) => { setDays(value as (typeof validities)[number]); forgetCopy() }} />
                {view.status === 'ok' && view.data && <span className="note small">{t('dashboard.share.until', { time: new Date(view.data.expiresAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
              </div>}
              {ticked.some((part) => valued.includes(part)) && <p className="note small">{t('dashboard.share.valuesShown')}</p>}
            </>}
          </div>
        )}
        {carrying && view.status === 'error' && <ErrorAlert error={view.error} />}
        <Input aria-label={t('dashboard.share.link')} value={link ?? t('common.loading')} onChange={() => undefined} />
        {copied && <p className={`note small${copied === 'failed' ? ' warning' : ''}`} role="status">{t(copied === 'copied' ? 'dashboard.share.copied' : 'dashboard.share.copyFailed')}</p>}
      </div>
    </Dialog>
  )
}
