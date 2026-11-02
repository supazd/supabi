import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { MultiSelect } from './MultiSelect'

const options = ['全体成员', 'admin (admin@example.com)', '用户组：测试用户组', '渠道', '用户 id', '金额'].map((label, index) => ({ label, value: String(index) }))
afterEach(cleanup)

it('shows all chosen values in wrap mode and supports removing any chip and clearing', () => {
  function Picker() {
    const [value, setValue] = useState(options.map((option) => option.value))
    return <MultiSelect wrap aria-label="Members" value={value} options={options} onChange={setValue} />
  }
  render(<Picker />)
  const box = screen.getByRole('combobox', { name: 'Members' })
  for (const option of options) expect(within(box).getByText(option.label)).toBeTruthy()
  expect(within(box).queryByText(/^\+\d+$/)).toBeNull()
  fireEvent.click(within(box).getByRole('button', { name: 'Remove 用户组：测试用户组' }))
  expect(within(box).queryByText('用户组：测试用户组')).toBeNull()
  expect(box.getAttribute('aria-expanded')).toBe('false')
  expect(within(box).getByText('金额')).toBeTruthy()
  fireEvent.click(within(box).getByRole('button', { name: 'Clear' }))
  expect(within(box).queryByText('金额')).toBeNull()
})

it('keeps the compact selection summary for controls that do not opt into wrapping', () => {
  render(<MultiSelect aria-label="Compact" value={options.map((option) => option.value)} options={options} onChange={() => {}} />)
  const box = screen.getByRole('combobox', { name: 'Compact' })
  expect(within(box).getByText('+4')).toBeTruthy()
  expect(within(box).queryByText('用户组：测试用户组')).toBeNull()
})

it('keeps the last value of a required choice', () => {
  function Picker() {
    const [value, setValue] = useState(['0', '1'])
    return <MultiSelect wrap required aria-label="Required" value={value} options={options} onChange={setValue} />
  }
  render(<Picker />)
  const box = screen.getByRole('combobox', { name: 'Required' })
  expect(within(box).queryByRole('button', { name: 'Clear' })).toBeNull()
  fireEvent.click(within(box).getByRole('button', { name: 'Remove 全体成员' }))
  expect(within(box).queryByText('全体成员')).toBeNull()
  expect(within(box).queryByRole('button', { name: /^Remove/ })).toBeNull()
  expect(within(box).getByText('admin (admin@example.com)')).toBeTruthy()
})
