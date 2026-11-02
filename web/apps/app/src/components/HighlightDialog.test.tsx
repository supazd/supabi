import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { Highlight } from '@supabi/charts'
import { openPopup } from '@supabi/ui/testing'
import { HighlightDialog } from './HighlightDialog'

beforeEach(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

const open = (value: Highlight[] | undefined) => {
  const done = vi.fn()
  render(<HighlightDialog name="Completion" value={value} format={{ style: 'percent' }} scheme="light" onDone={done} onCancel={() => undefined} />)
  return done
}
const rule = (n: number) => within(screen.getByRole('listitem', { name: `Rule ${n}` }))
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'OK' }))

describe('conditional format dialog', () => {
  it('writes each rule on a line, says what a threshold is shown as, and keeps the rules as they were', () => {
    const rules: Highlight[] = [{ op: 'lt', value: 0.8, color: 'red', icon: 'down' }, { op: 'gte', value: 1, color: 'green' }]
    const done = open(rules)
    expect(rule(1).getByRole('spinbutton', { name: 'Value' })).toHaveProperty('value', '0.8')
    rule(1).getByText('shown as 80%')
    rule(2).getByText('shown as 100%')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(rules)
  })

  it('adds rules in turn red, yellow and green, up to five, and refuses a rule without a number', () => {
    const done = open(undefined)
    screen.getByText('No rules yet: the column is not shaded.')
    const add = screen.getByRole('button', { name: 'Add rule' })
    fireEvent.click(add)
    expect(screen.getByRole('button', { name: 'OK' })).toHaveProperty('disabled', true)
    fireEvent.change(rule(1).getByRole('spinbutton', { name: 'Value' }), { target: { value: '-5' } })
    for (let n = 0; n < 4; n++) fireEvent.click(add)
    expect(add).toHaveProperty('disabled', true)
    screen.getByText('A column has at most 5 rules')
    for (const n of [2, 3, 4, 5]) fireEvent.change(rule(n).getByRole('spinbutton', { name: 'Value' }), { target: { value: String(n) } })
    confirm()
    expect(done.mock.calls[0]![0].map((rule: Highlight) => [rule.value, rule.color])).toEqual([[-5, 'red'], [2, 'yellow'], [3, 'green'], [4, 'blue'], [5, 'violet']])
  })

  it('moves a rule up, removes one, and sets the condition and the icon', async () => {
    const done = open([{ op: 'lt', value: 1, color: 'red' }, { op: 'gt', value: 2, color: 'green' }, { op: 'eq', value: 3, color: 'blue' }])
    expect(rule(1).getByRole('button', { name: 'Move up' })).toHaveProperty('disabled', true)
    fireEvent.click(rule(2).getByRole('button', { name: 'Move up' }))
    fireEvent.click(rule(3).getByRole('button', { name: 'Remove rule' }))
    openPopup(rule(1).getByRole('combobox', { name: 'Condition' }))
    fireEvent.click(await screen.findByRole('option', { name: 'is at least' }))
    openPopup(rule(1).getByRole('combobox', { name: 'Icon' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Up' }))
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith([{ op: 'gte', value: 2, color: 'green', icon: 'up' }, { op: 'lt', value: 1, color: 'red' }])
  })

  it('takes every rule away when all are removed', () => {
    const done = open([{ op: 'lt', value: 1, color: 'red' }])
    fireEvent.click(rule(1).getByRole('button', { name: 'Remove rule' }))
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
