import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { cleanParamFilter, fitsParam, newParamFilter, paramControl, paramFilterProblem, paramOptions, paramsNeedingValue, parseParamText, relativeDayLabel, relativeDayValue, withParamValues, type ParamFilter } from './paramFilters'
import type { SqlParam } from './params'

const t = ((key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`) as unknown as TFunction
const day: SqlParam = { name: 'day', type: 'date', default: { relative: 'today-1d' } }
const regions: SqlParam = { name: 'regions', type: 'string', multi: true, default: ['east', 'south'] }

describe('parameters the SQL cannot do without', () => {
  it('are those required and those written outside [[ ]], as the server finds them', () => {
    const sql = "SELECT * FROM t WHERE dt = {{day}} [[ AND region IN {{regions}} ]] [[ AND qty >= {{qty}} ]] -- {{note}}\n AND x = '{{text}}'"
    expect([...paramsNeedingValue(sql, [day, regions, { name: 'qty', type: 'integer', required: true }])].sort()).toEqual(['day', 'qty'])
    expect([...paramsNeedingValue('SELECT {{a}} [[ WHERE b = {{a}} ]]', [])]).toEqual(['a'])
  })
})

describe('a dropdown', () => {
  it('offers its default first where the author left it out', () => {
    expect(paramOptions({ id: 'p', param: 'regions', options: ['north', 'south'] }, regions)).toEqual(['east', 'north', 'south'])
    expect(paramOptions({ id: 'p', param: 'regions', options: ['north'], value: [] }, regions)).toEqual(['north'])
    expect(paramOptions({ id: 'p', param: 'paid' }, { name: 'paid', type: 'boolean' })).toEqual([true, false])
  })

  it('is described the way the server describes it to viewers', () => {
    const select: ParamFilter = { id: 'p', param: 'regions', label: 'R', control: { type: 'select' }, options: ['north'] }
    expect(paramControl(select, regions, false)).toEqual({ type: 'string', multi: true, default: ['east', 'south'], options: ['east', 'south', 'north'] })
    expect(paramControl({ id: 'd', param: 'day', label: 'D', control: { type: 'input' } }, day, true)).toEqual({ type: 'date', needsValue: true, default: { relative: 'today-1d' } })
    // No value of its own is no default, though the dataset has one.
    expect(paramControl({ ...select, value: null }, { ...regions, multi: false, default: 'east' }, false).default).toBeUndefined()
  })
})

describe('values', () => {
  it('are read as the parameter’s type, several separated by commas', () => {
    expect(parseParamText('2026-01-02', day)).toBe('2026-01-02')
    expect(parseParamText('today-1d', day)).toEqual({ relative: 'today-1d' })
    // Typed in by a viewer, a day is a day.
    expect(parseParamText('today-1d', day, false)).toBeUndefined()
    expect(parseParamText(' east, north ,', regions)).toEqual(['east', 'north'])
    expect(parseParamText('', day)).toBeNull()
    expect(parseParamText('', regions)).toEqual([])
    expect(parseParamText('1.5', { type: 'integer' })).toBeUndefined()
  })

  it('fit the parameter while its type and whether it takes several stay as they were', () => {
    expect(fitsParam(['east'], regions)).toBe(true)
    expect(fitsParam('east', regions)).toBe(false)
    expect(fitsParam({ relative: 'today' }, day)).toBe(true)
    expect(fitsParam({ relative: 'today' }, { type: 'integer' })).toBe(false)
    expect(fitsParam(5, { type: 'integer' })).toBe(true)
    expect(fitsParam('5', { type: 'integer' })).toBe(false)
    expect(fitsParam(1.5, { type: 'decimal' })).toBe(true)
    expect(fitsParam('1.50', { type: 'decimal' })).toBe(true)
    expect(fitsParam(1.5, { type: 'integer' })).toBe(false)
  })

  it('name days relative to today by what they are, and which day that is now', () => {
    const now = new Date(2026, 9, 22)
    expect(relativeDayLabel('today-1d', t, undefined, now)).toBe('params.filter.relativeDay{"name":"params.filter.yesterday","date":"10-21"}')
    expect(relativeDayLabel('today+3d', t, undefined, now)).toBe('params.filter.relativeDay{"name":"params.filter.daysLater{\\"count\\":3}","date":"10-25"}')
  })
})

describe('a parameter filter', () => {
  it('is written with nothing that says nothing, null kept apart from left out', () => {
    expect(cleanParamFilter({ id: 'p', param: 'day', value: '2026-01-02', options: ['x'], label: 'ignored' })).toEqual({ id: 'p', param: 'day', value: '2026-01-02' })
    expect(cleanParamFilter({ id: 'p', param: 'regions', label: 'R', control: { type: 'select' }, options: ['north'], value: null })).toEqual({ id: 'p', param: 'regions', value: null, label: 'R', control: { type: 'select' }, options: ['north'] })
    expect(cleanParamFilter({ id: 'p', param: 'day', label: 'D', control: { type: 'input' }, options: ['x'] })).toEqual({ id: 'p', param: 'day', label: 'D', control: { type: 'input' } })
    expect(newParamFilter(day, new Set(['p_day']))).toEqual({ id: 'p_day_2', param: 'day', label: 'day', control: { type: 'input' } })
  })

  it('says what keeps it from being saved', () => {
    expect(paramFilterProblem({ id: 'p', param: 'day' }, undefined, false)).toBe('missingParam')
    expect(paramFilterProblem({ id: 'p', param: 'day' }, day, true)).toBe('needsValue')
    expect(paramFilterProblem({ id: 'p', param: 'day', control: { type: 'input' } }, day, true)).toBe('needsLabel')
    expect(paramFilterProblem({ id: 'p', param: 'day', label: 'D', control: { type: 'input' }, value: null }, day, true)).toBe('needsDefault')
    expect(paramFilterProblem({ id: 'p', param: 'regions', label: 'R', control: { type: 'select' }, options: [1] }, regions, false)).toBe('typeChanged')
    expect(paramFilterProblem({ id: 'p', param: 'day', label: 'D', control: { type: 'input' } }, day, true)).toBeUndefined()
  })

  it('gives the query its parameters: chosen, else its own, else the dataset’s', () => {
    const filters: ParamFilter[] = [{ id: 'd', param: 'day', control: { type: 'input' } }, { id: 'r', param: 'regions', value: [] }]
    expect(withParamValues({ params: { other: 1 } }, filters, {})).toEqual({ params: { other: 1, regions: [] } })
    expect(withParamValues({}, filters, { d: '2026-01-02', r: ['north'] })).toEqual({ params: { day: '2026-01-02', regions: ['north'] } })
    expect(withParamValues({ dataset: 'x' }, [filters[0]!], {})).toEqual({ dataset: 'x' })
  })
})

describe('today', () => {
  it('is the day it is where queries are run, as the server takes it', () => {
    // 18:00 on 10-21 in Los Angeles is already 10-22 in Shanghai.
    const now = new Date('2026-10-22T01:00:00Z')
    expect(relativeDayValue('today-1d', 'Asia/Shanghai', now)).toBe('2026-10-21')
    expect(relativeDayValue('today-1d', 'America/Los_Angeles', now)).toBe('2026-10-20')
    expect(relativeDayValue('today+10d', 'UTC', now)).toBe('2026-11-01')
    expect(relativeDayValue('yesterday', 'UTC', now)).toBeUndefined()
  })
})
