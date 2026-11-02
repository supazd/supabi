import { cleanup, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { afterEach, expect, it } from 'vitest'
import '../i18n'
import { ApiError } from '../api/client'
import { ErrorAlert } from './ErrorAlert'

afterEach(cleanup)

it.each(['en-US', 'zh-CN'])('names a deleted field from its historical label in %s', async (language) => {
  await i18n.changeLanguage(language)
  render(<ErrorAlert error={new ApiError(400, 'unknown_field', 'unknown field', { key: 'f_72ab', label: 'Sales amount' })} />)
  expect(screen.getByText(i18n.t('errors.unknown_field', { label: 'Sales amount' }))).toBeTruthy()
  expect(document.body.textContent).not.toContain('f_72ab')
})

it.each(['en-US', 'zh-CN'])('falls back to the field key when no historical label is available in %s', async (language) => {
  await i18n.changeLanguage(language)
  render(<ErrorAlert error={new ApiError(400, 'unknown_field', 'unknown field', { key: 'f_72ab' })} />)
  expect(screen.getByText(i18n.t('errors.unknown_field', { label: 'f_72ab' }))).toBeTruthy()
  expect(document.body.textContent).not.toContain('{{label}}')
})
