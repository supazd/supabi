import { Button, Checkbox, Input, Radio, Select } from '@supabi/ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LoadOptions } from './FilterControl'

/** A searchable selection list for configuring a saved default. */
export function ExactFilterValues({ value, onChange, loadOptions, multi = true, excluded = false, serverSearch = false }: { value: unknown; onChange: (value: unknown[]) => void; loadOptions: LoadOptions; multi?: boolean; excluded?: boolean; serverSearch?: boolean }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'asc' | 'desc'>('asc')
  const [options, setOptions] = useState<unknown[]>([])
  const [truncated, setTruncated] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const selected: unknown[] = Array.isArray(value) ? value : []
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      setLoading(true); setFailed(false)
      loadOptions(search).then((result) => { if (current) { setOptions(result.values); setTruncated(result.truncated); setLoading(false) } }, () => { if (current) { setFailed(true); setLoading(false) } })
    }, search ? 250 : 0)
    return () => { current = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers create the loader while rendering
  }, [search])
  const key = (item: unknown) => JSON.stringify(item)
  const matches = (item: unknown) => !search || String(item).toLowerCase().includes(search.toLowerCase())
  // Typed server searches may match values written differently, such as
  // 1e2 and 100. Do not discard those results with a second text search.
  const listed = [...new Map([...selected.filter(matches), ...options.filter((item) => serverSearch || matches(item))].map((item) => [key(item), item])).values()]
    .sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * (sort === 'asc' ? 1 : -1))
  return <div className={`exact-filter-values${excluded ? ' excluded' : ''}`} aria-busy={loading}>
    <div className="row"><Input aria-label={t('filter.searchValues')} placeholder={t('filter.searchValues')} value={search} onChange={setSearch} clearable />
      <Select value={sort} aria-label={t('filter.sortValues')} options={[{ value: 'asc', label: t('filter.sortAsc') }, { value: 'desc', label: t('filter.sortDesc') }]} onChange={setSort} />
    </div>
    <div className="exact-filter-actions"><span className="note small exact-filter-count">{t(excluded ? 'filter.excludedCount' : 'filter.selectedCount', { count: selected.length })}</span><span className="spacer" />
      {multi && <Button size="sm" variant="ghost" onClick={() => onChange([...new Map([...selected, ...listed].map((item) => [key(item), item])).values()])}>{t('filter.allListed')}</Button>}
      <Button size="sm" variant="ghost" onClick={() => onChange([])}>{t('filter.clear')}</Button>
    </div>
    <div className="exact-filter-list" role={multi ? 'group' : 'radiogroup'} aria-label={t('filter.value')}>{listed.map((item) => {
      const checked = selected.some((current) => key(current) === key(item))
      return multi
        ? <Checkbox key={key(item)} checked={checked} onChange={(on) => onChange(on ? [...selected, item] : selected.filter((current) => key(current) !== key(item)))}>{String(item)}</Checkbox>
        : <Radio key={key(item)} checked={checked} onChange={() => onChange([item])}>{String(item)}</Radio>
    })}</div>
    {truncated && <p className="note small">{t('filter.moreOptions', { count: options.length })}</p>}
    {failed && <p className="note small" role="alert">{t('filter.optionsFailed')}</p>}
  </div>
}

/** Parses pasted tabular cells, including quoted CSV commas and escaped quotes. */
export function parseFilterValues(text: string, type: string): { values: unknown[]; invalid: boolean } {
  const cells: string[] = []
  let cell = '', quoted = false, wasQuoted = false, closed = false, invalid = false
  const finish = () => {
    // Quotes distinguish an exact string (including "") from blank input.
    if (wasQuoted || cell.trim()) cells.push(wasQuoted ? cell : cell.trim())
    cell = ''; wasQuoted = false; closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[i + 1] === '"') { cell += '"'; i++ }
      else { quoted = false; closed = true }
    } else if (char === ',' || char === '\t' || char === '\n' || char === '\r') finish()
    else if (closed) { if (char?.trim()) invalid = true }
    else if (char === '"') {
      if (cell.trim()) invalid = true
      else { cell = ''; quoted = true; wasQuoted = true }
    } else cell += char
  }
  finish()
  invalid ||= quoted
  const values = cells.map((cell) => {
    if (type === 'boolean') { const value = cell.trim(); if (value !== 'true' && value !== 'false') invalid = true; return value === 'true' }
    if (['integer', 'decimal', 'float'].includes(type)) { const value = Number(cell); if (!cell.trim() || !Number.isFinite(value) || type === 'integer' && !Number.isInteger(value)) invalid = true; return value }
    return cell
  })
  return { values: [...new Map(values.map((value) => [JSON.stringify(value), value])).values()], invalid }
}
