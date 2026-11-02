import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useHistory } from './useHistory'

afterEach(cleanup)

describe('editor history', () => {
  it('combines consecutive typing until the group ends or another edit happens', () => {
    const { result } = renderHook(() => useHistory({ name: '', description: '' }))
    act(() => {
      result.current.update((draft) => ({ ...draft, name: 'A' }), { group: 'name' })
      result.current.update((draft) => ({ ...draft, name: 'AB' }), { group: 'name' })
      result.current.update((draft) => ({ ...draft, name: 'ABC' }), { group: 'name' })
      result.current.endGroup()
      result.current.update((draft) => ({ ...draft, name: 'ABCD' }), { group: 'name' })
      result.current.update((draft) => ({ ...draft, description: 'About' }))
      result.current.update((draft) => ({ ...draft, name: 'ABCDE' }), { group: 'name' })
    })
    expect(result.current.value).toEqual({ name: 'ABCDE', description: 'About' })
    act(() => result.current.undo())
    expect(result.current.value).toEqual({ name: 'ABCD', description: 'About' })
    act(() => result.current.undo())
    expect(result.current.value).toEqual({ name: 'ABCD', description: '' })
    act(() => result.current.undo())
    expect(result.current.value.name).toBe('ABC')
    act(() => result.current.undo())
    expect(result.current.value.name).toBe('')
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.redo())
    expect(result.current.value.name).toBe('ABC')
  })

  it('starts a new history on reset, dropping both undo and redo states', () => {
    const { result } = renderHook(() => useHistory({ name: '' }))
    act(() => {
      result.current.update({ name: 'A' })
      result.current.update({ name: 'AB' })
      result.current.undo()
    })
    expect(result.current.canUndo && result.current.canRedo).toBe(true)
    act(() => result.current.reset({ name: 'Merged' }))
    expect(result.current).toMatchObject({ value: { name: 'Merged' }, canUndo: false, canRedo: false })
    act(() => result.current.undo())
    expect(result.current.value.name).toBe('Merged')
  })

  it('undoes chart deletion and its filter mappings as one snapshot', () => {
    const initial = {
      items: [{ id: 'one' }, { id: 'two' }],
      filters: [{ id: 'region', targets: [{ item: 'one', field: 'region' }, { item: 'two', field: 'region' }] }],
    }
    const { result } = renderHook(() => useHistory(initial))
    act(() => result.current.update((draft) => ({
      items: draft.items.filter((item) => item.id !== 'one'),
      filters: draft.filters.map((filter) => ({ ...filter, targets: filter.targets.filter((target) => target.item !== 'one') })),
    })))
    const removed = result.current.value
    expect(removed.items).toEqual([{ id: 'two' }])
    expect(removed.filters[0]!.targets).toEqual([{ item: 'two', field: 'region' }])
    act(() => result.current.undo())
    expect(result.current.value).toEqual(initial)
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.redo())
    expect(result.current.value).toEqual(removed)
    expect(result.current.canRedo).toBe(false)
  })

  it('keeps save checkpoints independent so undo and redo can cross a save', () => {
    const { result } = renderHook(() => useHistory({ name: 'Original' }))
    act(() => result.current.update({ name: 'Saved' }, { group: 'name' }))
    const checkpoint = JSON.stringify(result.current.value)
    act(() => result.current.endGroup())
    act(() => result.current.update({ name: 'Changed' }, { group: 'name' }))
    expect(JSON.stringify(result.current.value)).not.toBe(checkpoint)
    act(() => result.current.undo())
    expect(JSON.stringify(result.current.value)).toBe(checkpoint)
    act(() => result.current.undo())
    expect(result.current.value.name).toBe('Original')
    act(() => result.current.redo())
    expect(JSON.stringify(result.current.value)).toBe(checkpoint)
  })

  it('ignores equivalent drafts without adding history or losing redo', () => {
    const { result } = renderHook(() => useHistory({ items: [{ id: 'one', x: 0 }] }))
    act(() => result.current.update({ items: [{ id: 'one', x: 0 }] }))
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.update({ items: [{ id: 'one', x: 1 }] }))
    act(() => result.current.undo())
    act(() => result.current.update((draft) => ({ items: draft.items.map((item) => ({ ...item })) })))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.redo())
    expect(result.current.value.items[0]!.x).toBe(1)
  })

  it('discards the redo branch only after a changed update', () => {
    const { result } = renderHook(() => useHistory(0))
    act(() => {
      result.current.update((value) => value + 1)
      result.current.update((value) => value + 1)
    })
    expect(result.current.value).toBe(2)
    act(() => result.current.undo())
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.update(3))
    expect(result.current.canRedo).toBe(false)
    act(() => result.current.redo())
    expect(result.current.value).toBe(3)
    act(() => result.current.undo())
    expect(result.current.value).toBe(1)
  })

  it('normalizes the present within its existing edit and keeps its text group', () => {
    const { result } = renderHook(() => useHistory({ name: '', x: 0 }))
    act(() => {
      result.current.update({ name: 'A', x: 1 }, { group: 'name' })
      result.current.update((draft) => ({ ...draft, x: 2 }), { replace: true })
      result.current.update((draft) => ({ ...draft, name: 'AB' }), { group: 'name' })
    })
    expect(result.current.value).toEqual({ name: 'AB', x: 2 })
    act(() => result.current.undo())
    expect(result.current.value).toEqual({ name: '', x: 0 })
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.redo())
    expect(result.current.value).toEqual({ name: 'AB', x: 2 })
  })

  it('preserves redo when the layout normalizes after an undo', () => {
    const { result } = renderHook(() => useHistory({ x: 0 }))
    act(() => result.current.update({ x: 2 }))
    act(() => result.current.undo())
    act(() => result.current.update({ x: 1 }, { replace: true }))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.redo())
    expect(result.current.value.x).toBe(2)
    act(() => result.current.undo())
    expect(result.current.value.x).toBe(1)
  })

  it('keeps the most recent one hundred edits', () => {
    const { result } = renderHook(() => useHistory(0))
    act(() => {
      for (let i = 0; i < 110; i++) result.current.update((value) => value + 1)
      for (let i = 0; i < 110; i++) result.current.undo()
    })
    expect(result.current.value).toBe(10)
    expect(result.current.canUndo).toBe(false)
    act(() => {
      for (let i = 0; i < 110; i++) result.current.redo()
    })
    expect(result.current.value).toBe(110)
    expect(result.current.canRedo).toBe(false)
  })
})
