// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

afterEach(cleanup)

describe('Button', () => {
  it('renders its label and reports clicks', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('is a plain button unless asked to submit', () => {
    render(
      <>
        <Button>Plain</Button>
        <Button type="submit">Send</Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Plain' }).getAttribute('type')).toBe('button')
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('type')).toBe('submit')
  })

  it('ignores clicks while disabled or loading', () => {
    const onClick = vi.fn()
    render(
      <>
        <Button disabled onClick={onClick}>
          Off
        </Button>
        <Button loading onClick={onClick} aria-label="Busy" />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Busy' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})
