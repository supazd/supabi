import { DataTable, DateRangeInput, Segmented } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { Async } from '../../components/Async'
import { dayStart, SettingsPage } from './shared'
import './aiUsage.css'

type AIUsage = Schemas['AIUsage']
type AIUsageGroup = Schemas['AIUsageGroup']
type AIUsageReport = Schemas['AIUsageReport']
type GroupBy = Schemas['AIUsageGroupBy']

const groupings: GroupBy[] = ['user', 'model', 'workspace', 'purpose', 'day']

/** A day as YYYY-MM-DD in the browser's time zone, days after today. */
function localDay(after = 0) {
  const date = new Date()
  date.setDate(date.getDate() + after)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The last 30 days, today among them. */
const recentDays = (): [string | undefined, string | undefined] => [localDay(-29), localDay()]

function useLabels() {
  const { t, i18n } = useTranslation()
  const number = new Intl.NumberFormat(i18n.language)
  const money = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  const amount = (decimal: string) => {
    const n = Number(decimal)
    // So that a call costing next to nothing does not read as free.
    return n > 0 && n < 0.0001 ? `< ${money.format(0.0001)}` : money.format(n)
  }
  return {
    number: (n: number) => number.format(n),
    /** Each currency apart, never added together: there is no rate to turn one into another. */
    costs: (usage: AIUsage) => usage.costs.length ? usage.costs.map((c) => `${c.currency} ${amount(c.amount)}`).join(' · ') : '—',
    day: (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(i18n.language),
    purpose: (purpose: string) => t(`aiUsage.purposes.${purpose}`, { defaultValue: purpose }),
  }
}

/**
 * What the assistant's calls to models used and cost, for system
 * administrators. It shows nothing of what people asked:
 * .agents/design/ai-assistant.md 13.
 */
export function AIUsage() {
  const { t } = useTranslation()
  const [dates, setDates] = useState(recentDays)
  const [groupBy, setGroupBy] = useState<GroupBy>('user')
  const [from, to] = dates
  // Figures are never kept from an earlier choice: under another time, or after a load failed, they would pass for this one's.
  // The grouping goes with the groups, so that rows loaded for one are not named as another's before the next load starts.
  const report = useAsync(async () => {
    const query = { groupBy, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, from: from && dayStart(from), to: to && dayStart(to, 1) }
    return { by: groupBy, report: await unwrap(api.GET('/ai/usage', { params: { query } })) }
  }, [groupBy, from, to])

  return (
    <SettingsPage title={t('settings.aiUsage')} hint={t('aiUsage.hint')}>
      <div className="settings-toolbar">
        <DateRangeInput size="sm" value={dates} onChange={setDates} placeholder={[t('audit.dateFrom'), t('audit.dateTo')]} aria-label={t('aiUsage.dates')} />
        <Segmented aria-label={t('aiUsage.groupBy')} value={groupBy} onChange={setGroupBy} options={groupings.map((g) => ({ value: g, label: t(`aiUsage.by.${g}`) }))} />
      </div>
      <Async state={report} reload={report.reload}>
        {({ by, report: r }) => (
          <>
            <Totals report={r} />
            <Groups by={by} groups={r.groups} />
          </>
        )}
      </Async>
    </SettingsPage>
  )
}

function Totals({ report }: { report: AIUsageReport }) {
  const { t } = useTranslation()
  const label = useLabels()
  const { total } = report
  const calls = [label.number(total.calls), total.failed > 0 && t('aiUsage.failed', { count: total.failed }), total.stopped > 0 && t('aiUsage.stopped', { count: total.stopped })]
  const tokens = [
    `${t('aiUsage.input')} ${label.number(total.inputTokens)}`,
    `${t('aiUsage.cachedInput')} ${label.number(total.cachedInputTokens)}`,
    `${t('aiUsage.cacheWrite')} ${label.number(total.cacheWriteTokens)}`,
    `${t('aiUsage.output')} ${label.number(total.outputTokens)}`,
  ]
  return (
    <dl className="facts" aria-label={t('aiUsage.total')}>
      <dt>{t('aiUsage.cost')}</dt>
      <dd>{label.costs(total)}</dd>
      <dt>{t('aiUsage.answers')}</dt>
      <dd>{label.number(report.answers)}</dd>
      <dt>{t('aiUsage.calls')}</dt>
      <dd>{calls.filter(Boolean).join(' · ')}</dd>
      <dt>{t('aiUsage.tokens')}</dt>
      <dd>
        {tokens.join(' · ')}
        {total.estimated > 0 && <span className="note"> {t('aiUsage.estimated', { count: total.estimated })}</span>}
      </dd>
    </dl>
  )
}

function Groups({ by, groups }: { by: GroupBy; groups: AIUsageGroup[] }) {
  const { t } = useTranslation()
  const label = useLabels()
  const tokens = (key: string, title: string, of: (u: AIUsage) => number) => ({ key, title, align: 'right' as const, render: (g: AIUsageGroup) => label.number(of(g.usage)) })
  return (
    <DataTable
      aria-label={t('settings.aiUsage')}
      rows={groups}
      rowKey={(g) => g.key}
      empty={t('aiUsage.empty')}
      columns={[
        { key: 'name', title: t(`aiUsage.groupTitles.${by}`), render: (g) => <GroupName by={by} group={g} /> },
        tokens('calls', t('aiUsage.calls'), (u) => u.calls),
        tokens('input', t('aiUsage.input'), (u) => u.inputTokens),
        tokens('cachedInput', t('aiUsage.cachedInput'), (u) => u.cachedInputTokens),
        tokens('cacheWrite', t('aiUsage.cacheWrite'), (u) => u.cacheWriteTokens),
        tokens('output', t('aiUsage.output'), (u) => u.outputTokens),
        { key: 'cost', title: t('aiUsage.cost'), align: 'right', render: (g) => label.costs(g.usage) },
      ]}
    />
  )
}

function GroupName({ by, group }: { by: GroupBy; group: AIUsageGroup }) {
  const { t } = useTranslation()
  const label = useLabels()
  switch (by) {
    case 'user':
      return group.displayName
        ? <span className="ai-usage-stacked">{group.displayName}<span className="note small">{group.email}</span></span>
        : <span>{group.email || group.key}</span>
    case 'model':
      return <span>{[group.provider, group.model].filter(Boolean).join(' · ')}</span>
    case 'workspace':
      // Tests of models are made from the system settings, in no workspace.
      if (!group.key) return <span className="note">{t('aiUsage.modelTests')}</span>
      return group.workspaceName ? <span>{group.workspaceName}</span> : <span className="note">{t('aiUsage.purgedWorkspace')}</span>
    case 'purpose':
      return <span>{label.purpose(group.key)}</span>
    case 'day':
      return <time dateTime={group.key}>{label.day(group.key)}</time>
  }
}
