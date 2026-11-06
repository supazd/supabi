import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridGroup, type GridMove } from './GridGroup'
import { GridLayout, type GridItem } from './GridLayout'

const gridWidth = 1200
const gridLeft = 120
const gridTop = 80
const gap = 12
const rowHeight = 48
// Twelve columns give a 101px pitch; rows have a 60px pitch.
const initialItems: GridItem[] = [
  { id: 'first', x: 2, y: 0, w: 4, h: 2 },
  { id: 'second', x: 6, y: 0, w: 4, h: 2 },
]

function position(element: HTMLElement) {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(element.style.transform)
  if (!match) throw new Error(`Expected an item translation, got ${element.style.transform}`)
  return { left: Number(match[1]), top: Number(match[2]) }
}

function ControlledGrid({ onChange = () => {}, onNormalize, onRemove = () => {}, startingItems = initialItems, scale = 1, containerGap = 0, autoCompact = true, columnGap }: { scale?: number; containerGap?: number; autoCompact?: boolean; columnGap?: number; onChange?: (items: GridItem[]) => void; onNormalize?: (items: GridItem[]) => void; onRemove?: (id: string) => void; startingItems?: GridItem[] }) {
  const [items, setItems] = useState(startingItems)
  return (
    <>
      <GridLayout
        items={items}
        columns={12 * scale}
        rowHeight={rowHeight / scale}
        gap={gap / scale}
        columnGap={columnGap}
        containerGap={containerGap}
        autoCompact={autoCompact}
        unitScale={scale}
        editable
        handleSelector=".chart-handle"
        cancelSelector=".chart-handle button"
        onChange={(next) => { setItems(next); onChange(next) }}
        onNormalize={onNormalize && ((next) => { setItems(next); onNormalize(next) })}
        renderItem={(item) => (
          <>
            <header className="chart-handle" data-testid={`chart-header-${item.id}`}>
              <h3>{item.id}</h3>
              <button type="button" onClick={() => onRemove(item.id)}><span>Remove {item.id}</span></button>
            </header>
            <div data-testid={`chart-body-${item.id}`}>Chart body</div>
          </>
        )}
      />
      <output data-testid="saved-layout">{JSON.stringify(items)}</output>
    </>
  )
}

function takeHold(id = 'first') {
  const handle = screen.getByText(id)
  const item = handle.closest<HTMLElement>('.react-grid-item')!
  const start = position(item)
  // Hold the title away from the top-left corner to catch pointer-offset jumps.
  const pointer = { clientX: gridLeft + start.left + 73, clientY: gridTop + start.top + 24 }
  fireEvent.mouseDown(handle, { ...pointer, button: 0 })
  return { item, start, pointer }
}

function controlAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  return () => act(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(16)
  })
}

beforeEach(() => {
  // JSDOM has no layout engine. Supply browser measurements only: the actual
  // GridLayout, width hook, DraggableCore and react-grid-layout all run here.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(gridWidth)
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-grid-item') ? this.closest('.react-grid-layout') : document.body
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>('[data-scroll-container]')
    const scrollTop = scroller && scroller !== this ? scroller.scrollTop : 0
    if (this.classList.contains('react-grid-item')) {
      const { left, top } = position(this)
      return new DOMRect(gridLeft + left, gridTop + top - scrollTop, parseFloat(this.style.width), parseFloat(this.style.height))
    }
    return new DOMRect(gridLeft, gridTop - scrollTop, gridWidth, scroller === this ? 240 : 600)
  })
})

afterEach(() => {
  // Also remove document drag listeners when an assertion interrupts a drag.
  fireEvent.mouseUp(document)
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GridLayout dragging', () => {
  it('separates automatic compaction from a user’s released drag for undo history', () => {
    const onChange = vi.fn()
    const onNormalize = vi.fn()
    render(<ControlledGrid onChange={onChange} onNormalize={onNormalize} startingItems={initialItems.map((item) => ({ ...item, y: 3 }))} />)
    expect(onNormalize).toHaveBeenCalledExactlyOnceWith(initialItems)
    expect(onChange).not.toHaveBeenCalled()
    const { pointer } = takeHold()
    fireEvent.mouseMove(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })
    fireEvent.mouseUp(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...initialItems[0], x: 6 }, { ...initialItems[1], y: 2 }])
    expect(onNormalize).toHaveBeenCalledTimes(1)
  })

  it('keeps automatic compaction compatible with callers that only supply onChange', () => {
    const onChange = vi.fn()
    render(<ControlledGrid onChange={onChange} startingItems={initialItems.map((item) => ({ ...item, y: 3 }))} />)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(initialItems)
  })

  it('drags from both the header background and its nested title', () => {
    render(<ControlledGrid />)
    const header = screen.getByTestId('chart-header-first')
    const title = screen.getByText('first')
    const item = header.closest<HTMLElement>('.react-grid-item')!
    const start = position(item)
    const pointer = { clientX: gridLeft + start.left + 73, clientY: gridTop + start.top + 24 }

    for (const target of [header, title]) {
      fireEvent.mouseDown(target, { ...pointer, button: 0 })
      fireEvent.mouseMove(document, { clientX: pointer.clientX + 20, clientY: pointer.clientY + 10 })
      expect(item.classList.contains('react-draggable-dragging')).toBe(true)
      expect(position(item)).toEqual({ left: start.left + 20, top: start.top + 10 })
      fireEvent.mouseUp(document, { clientX: pointer.clientX + 20, clientY: pointer.clientY + 10 })
      expect(position(item)).toEqual(start)
    }
  })

  it('keeps header buttons clickable and excludes their contents and the chart body from dragging', () => {
    const onChange = vi.fn()
    const onRemove = vi.fn()
    render(<ControlledGrid onChange={onChange} onRemove={onRemove} />)
    const button = screen.getByRole('button', { name: 'Remove first' })
    const label = screen.getByText('Remove first')
    const body = screen.getByTestId('chart-body-first')
    const item = button.closest<HTMLElement>('.react-grid-item')!
    const start = position(item)
    const pointer = { clientX: gridLeft + start.left + 73, clientY: gridTop + start.top + 24 }

    for (const target of [button, label, body]) {
      fireEvent.mouseDown(target, { ...pointer, button: 0 })
      fireEvent.mouseMove(document, { clientX: pointer.clientX + 120, clientY: pointer.clientY + 10 })
      expect(item.classList.contains('react-draggable-dragging')).toBe(false)
      expect(position(item)).toEqual(start)
      fireEvent.mouseUp(document, { clientX: pointer.clientX + 120, clientY: pointer.clientY + 10 })
      fireEvent.click(target)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(onRemove).toHaveBeenCalledTimes(2)
    expect(onRemove).toHaveBeenNthCalledWith(1, 'first')
    expect(onRemove).toHaveBeenNthCalledWith(2, 'first')
  })

  it('follows every pointer move within a grid cell and retains the initial grab offset', () => {
    const onChange = vi.fn()
    render(<ControlledGrid onChange={onChange} />)
    const { item, start, pointer } = takeHold()

    for (const [dx, dy] of [[10, 8], [20, 12], [30, 18]] as const) {
      fireEvent.mouseMove(document, { clientX: pointer.clientX + dx, clientY: pointer.clientY + dy })
      expect(position(item)).toEqual({ left: start.left + dx, top: start.top + dy })
      const rect = item.getBoundingClientRect()
      expect(pointer.clientX + dx - rect.left).toBe(73)
      expect(pointer.clientY + dy - rect.top).toBe(24)
    }
    // These moves never cross a cell boundary and must not persist a new layout.
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.mouseUp(document, { clientX: pointer.clientX + 30, clientY: pointer.clientY + 18 })
    expect(position(item)).toEqual(start)
  })

  it('includes small pre-threshold moves when the drag starts', () => {
    render(<ControlledGrid />)
    const { item, start, pointer } = takeHold()

    for (const dx of [1, 2]) {
      fireEvent.mouseMove(document, { clientX: pointer.clientX + dx, clientY: pointer.clientY })
      expect(position(item)).toEqual(start)
    }
    fireEvent.mouseMove(document, { clientX: pointer.clientX + 4, clientY: pointer.clientY })
    expect(position(item)).toEqual({ left: start.left + 4, top: start.top })
  })

  it('persists the released layout and moves a collided chart out of the way', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ControlledGrid onChange={onChange} />)
    const { item, pointer } = takeHold()
    // Move four columns right onto the second chart.
    fireEvent.mouseMove(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })
    fireEvent.mouseUp(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })

    const saved = JSON.parse(screen.getByTestId('saved-layout').textContent!) as GridItem[]
    const first = saved.find((entry) => entry.id === 'first')!
    const second = saved.find((entry) => entry.id === 'second')!
    expect(first).toEqual({ ...initialItems[0], x: 6 })
    expect(second).toEqual({ ...initialItems[1], y: 2 })
    expect(onChange).toHaveBeenCalledWith(saved)
    expect(item.classList.contains('react-draggable-dragging')).toBe(false)
    expect(document.querySelector('.react-grid-placeholder')).toBeNull()

    rerender(<ControlledGrid onChange={onChange} />)
    expect(position(item)).toEqual({ left: 606, top: 0 })
    expect(position(screen.getByText('second').closest<HTMLElement>('.react-grid-item')!)).toEqual({ left: 606, top: 120 })
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)).toEqual(saved)
  })

  it.each([false, true])('keeps the grabbed point under a stationary pointer during edge scrolling (move again: %s)', (moveAgain) => {
    const nextFrame = controlAnimationFrames()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
    const stacked = Array.from({ length: 8 }, (_, index) => ({ id: index === 0 ? 'first' : `chart-${index}`, x: 2, y: index * 2, w: 4, h: 2 }))
    render(<div data-testid="scroller" data-scroll-container style={{ overflowY: 'auto' }}><ControlledGrid startingItems={stacked} /></div>)
    const scroller = screen.getByTestId('scroller')
    const { item, start, pointer } = takeHold()
    // The scroll viewport ends at y=320; leave the pointer 20px above its edge.
    const edgePointer = { clientX: pointer.clientX, clientY: 300 }
    fireEvent.mouseMove(document, edgePointer)
    const pointerDelta = edgePointer.clientY - pointer.clientY

    for (let frame = 0; frame < 10; frame++) {
      nextFrame()
      expect(scroller.scrollTop).toBe((frame + 1) * 12)
      expect(position(item)).toEqual({ left: start.left, top: start.top + pointerDelta + scroller.scrollTop })
      expect(edgePointer.clientY - item.getBoundingClientRect().top).toBe(24)
    }

    if (moveAgain) {
      edgePointer.clientX += 1
      edgePointer.clientY += 2
      fireEvent.mouseMove(document, edgePointer)
      // DraggableCore also observes the changed parent rect: its next event
      // must not count the 120px of scrolling a second time.
      expect(position(item)).toEqual({ left: start.left + 1, top: start.top + pointerDelta + 120 + 2 })
      expect(edgePointer.clientY - item.getBoundingClientRect().top).toBe(24)
    }

    fireEvent.mouseUp(document, edgePointer)
    const saved = JSON.parse(screen.getByTestId('saved-layout').textContent!) as GridItem[]
    expect(saved.find((entry) => entry.id === 'first')).toEqual({ id: 'first', x: 2, y: 4, w: 4, h: 2 })
    expect([...saved].sort((a, b) => a.y - b.y).map((entry) => entry.id)).toEqual(['chart-1', 'chart-2', 'first', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7'])
    expect(position(item)).toEqual({ left: 202, top: 240 })
    // DraggableCore can still schedule selection cleanup after release.
    // Running those callbacks must not keep scrolling or change the layout.
    for (let frame = 0; frame < 3; frame++) nextFrame()
    expect(scroller.scrollTop).toBe(120)
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)).toEqual(saved)
    expect(position(item)).toEqual({ left: 202, top: 240 })
  })

  it('stops edge scrolling when the grid is unmounted during a drag', () => {
    const nextFrame = controlAnimationFrames()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
    const { unmount } = render(<div data-testid="scroller" data-scroll-container style={{ overflowY: 'auto' }}><ControlledGrid /></div>)
    const scroller = screen.getByTestId('scroller')
    const { pointer } = takeHold()
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: 300 })
    nextFrame()
    expect(scroller.scrollTop).toBe(12)

    unmount()
    for (let frame = 0; frame < 3; frame++) nextFrame()
    expect(scroller.scrollTop).toBe(12)
  })

  it('still accepts a chart dragged from outside and makes room at its drop position', () => {
    const onDropItem = vi.fn()
    const { container } = render(
      <GridLayout
        items={initialItems}
        columns={12}
        rowHeight={rowHeight}
        gap={gap}
        editable
        dropType="application/x-supabi-chart"
        dropSize={{ w: 4, h: 2 }}
        onDropItem={onDropItem}
        renderItem={(item) => <div>{item.id}</div>}
      />,
    )
    const grid = container.querySelector<HTMLElement>('.react-grid-layout')!
    const dataTransfer = { types: ['application/x-supabi-chart'], getData: () => 'new-chart' }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      // JSDOM has no DragEvent; use its mouse coordinates and supply the payload.
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: gridLeft + 202 + 196, clientY: gridTop })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      fireEvent(grid, event)
    }
    expect(onDropItem).toHaveBeenCalledExactlyOnceWith('new-chart', { x: 2, y: 0, w: 4, h: 2 }, [
      { ...initialItems[0], y: 2 },
      initialItems[1],
    ])
    expect(document.querySelector('.react-grid-placeholder')).toBeNull()
  })

  it('hands a chart dropped onto an item that takes it to that item, making no room for it', () => {
    const onDropItem = vi.fn()
    const onDropInto = vi.fn()
    const { container } = render(
      <GridLayout
        items={initialItems}
        columns={12}
        rowHeight={rowHeight}
        gap={gap}
        editable
        dropType="application/x-supabi-chart"
        dropSize={{ w: 4, h: 2 }}
        onDropItem={onDropItem}
        dropIntoAttribute="data-drop-into"
        onDropInto={onDropInto}
        renderItem={(item) => <div data-drop-into={item.id}><span>{item.id}</span></div>}
      />,
    )
    const target = screen.getByText(initialItems[1]!.id)
    const dataTransfer = { types: ['application/x-supabi-chart'], getData: () => 'new-chart' }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: gridLeft + 202, clientY: gridTop })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      fireEvent(target, event)
      if (type === 'dragover') expect(container.querySelector('.react-grid-item.dropping')).toBeNull()
    }
    expect(onDropInto).toHaveBeenCalledExactlyOnceWith('new-chart', initialItems[1]!.id)
    expect(onDropItem).not.toHaveBeenCalled()
  })

  it('makes room for a drag that carries the excepted type, even over an item that takes drops', () => {
    const onDropItem = vi.fn()
    const onDropInto = vi.fn()
    render(
      <GridLayout
        items={initialItems}
        columns={12}
        rowHeight={rowHeight}
        gap={gap}
        editable
        dropType="application/x-supabi-chart"
        dropSize={{ w: 4, h: 2 }}
        onDropItem={onDropItem}
        dropIntoAttribute="data-drop-into"
        dropIntoExcept="application/x-supabi-empty-chart"
        onDropInto={onDropInto}
        renderItem={(item) => <div data-drop-into={item.id}><span>{item.id}</span></div>}
      />,
    )
    const target = screen.getByText(initialItems[1]!.id)
    const dataTransfer = { types: ['application/x-supabi-chart', 'application/x-supabi-empty-chart'], getData: (type: string) => type === 'application/x-supabi-chart' ? 'empty' : '' }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: gridLeft + 202, clientY: gridTop })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      fireEvent(target, event)
    }
    expect(onDropInto).not.toHaveBeenCalled()
    expect(onDropItem).toHaveBeenCalledOnce()
  })

  it('keeps an external chart aligned after edge scrolling and another dragover event', () => {
    const nextFrame = controlAnimationFrames()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
    const onDropItem = vi.fn()
    const { container } = render(
      <div data-testid="scroller" data-scroll-container style={{ overflowY: 'auto' }}>
        <GridLayout
          items={initialItems}
          columns={12}
          rowHeight={rowHeight}
          gap={gap}
          editable
          dropType="application/x-supabi-chart"
          dropSize={{ w: 4, h: 2 }}
          onDropItem={onDropItem}
          renderItem={(item) => <div>{item.id}</div>}
        />
      </div>,
    )
    const grid = container.querySelector<HTMLElement>('.react-grid-layout')!
    const scroller = screen.getByTestId('scroller')
    const dragEvent = (type: string, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: gridLeft + 202 + 196, clientY })
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['application/x-supabi-chart'], getData: () => 'new-chart' } })
      fireEvent(grid, event)
    }
    dragEvent('dragenter', 296)
    dragEvent('dragover', 296)
    dragEvent('dragover', 300)
    const preview = container.querySelector<HTMLElement>('.react-grid-item.dropping')!
    // External previews are centered on the pointer (108px high).
    expect(position(preview)).toEqual({ left: 202, top: 166 })
    for (let frame = 0; frame < 3; frame++) nextFrame()
    expect(scroller.scrollTop).toBe(36)
    expect(position(preview)).toEqual({ left: 202, top: 202 })
    expect(300 - preview.getBoundingClientRect().top).toBe(54)

    // Drop previews pass an absolute target converted to a delta, unlike
    // DraggableCore: this event must not subtract the scroll compensation again.
    dragEvent('dragover', 302)
    expect(position(preview)).toEqual({ left: 202, top: 204 })
    expect(302 - preview.getBoundingClientRect().top).toBe(54)
    dragEvent('drop', 302)
    expect(onDropItem).toHaveBeenCalledExactlyOnceWith('new-chart', { x: 2, y: 4, w: 4, h: 2 }, initialItems)
    for (let frame = 0; frame < 3; frame++) nextFrame()
    expect(scroller.scrollTop).toBe(36)
    expect(container.querySelector('.react-grid-item.dropping')).toBeNull()
  })
})


describe('fine grid', () => {
  it('resizes by one fine cell on both axes and matches the placeholder edges', () => {
    render(<ControlledGrid scale={8} startingItems={[{ id: 'first', x: 16, y: 0, w: 32, h: 32 }]} />)
    const item = screen.getByText('first').closest<HTMLElement>('.react-grid-item')!
    const handle = item.querySelector('.react-resizable-handle')!
    const rect = item.getBoundingClientRect()
    const pointer = { clientX: rect.right, clientY: rect.bottom }
    const destination = { clientX: pointer.clientX + (gridWidth + gap / 8) / 96, clientY: pointer.clientY + (rowHeight + gap) / 8 }
    fireEvent.mouseDown(handle, { ...pointer, button: 0 })
    fireEvent.mouseMove(document, destination)
    const placeholder = document.querySelector<HTMLElement>('.react-grid-placeholder')!
    expect(item.style.getPropertyValue('--grid-snap-width')).toBe(placeholder.style.width)
    expect(item.style.getPropertyValue('--grid-snap-height')).toBe(placeholder.style.height)
    expect(position(placeholder)).toEqual(position(item))
    const expectedHeight = Math.round(33 * (rowHeight + gap) / 8) - gap / 8
    expect(parseFloat(placeholder.style.height)).toBe(expectedHeight)
    fireEvent.mouseUp(document, destination)
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)).toEqual([{ id: 'first', x: 16, y: 0, w: 33, h: 33 }])
    expect(parseFloat(item.style.height)).toBe(expectedHeight)
    const cells = document.querySelector<HTMLElement>('.lb-grid-cells')!
    const svg = decodeURIComponent(cells.style.maskImage)
    expect(svg).toContain('<rect')
    expect(svg).not.toContain('<path')
    expect(svg.match(/<rect /g)).toHaveLength(192)
    expect(svg).toContain('height="6.5"')
  })

  it('raises the minimum height to fit content and prevents resizing below it', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-testid="chart-body-first"]') ? 56 : 0
    })
    const initial = { id: 'first', x: 0, y: 0, w: 32, h: 8, minH: 8, minContentSelector: '[data-testid="chart-body-first"]', contentPadding: 26 }
    render(<ControlledGrid scale={8} startingItems={[initial]} />)
    // 56px controls + 26px padding + 1.5px spacing => 12 fine rows.
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)[0].h).toBe(12)
    const item = screen.getByText('first').closest<HTMLElement>('.react-grid-item')!
    const handle = item.querySelector('.react-resizable-handle')!
    const rect = item.getBoundingClientRect()
    fireEvent.mouseDown(handle, { clientX: rect.right, clientY: rect.bottom, button: 0 })
    fireEvent.mouseMove(document, { clientX: rect.right, clientY: rect.bottom - 48 })
    fireEvent.mouseUp(document, { clientX: rect.right, clientY: rect.bottom - 48 })
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)[0].h).toBe(12)
  })
})


describe('content height modes', () => {
  it.each([false, true])('fits growing content and only shrinks in automatic mode (%s)', (autoHeight) => {
    const callbacks = new Set<() => void>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element) { if (target.matches('[data-testid="chart-body-first"]')) callbacks.add(this.callback) }
      unobserve() {}
      disconnect() { callbacks.delete(this.callback) }
    })
    let contentHeight = 56
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-testid="chart-body-first"]') ? contentHeight : 0
    })
    const first = { id: 'first', x: 0, y: 0, w: 32, h: 32, minH: 6, autoHeight, minContentSelector: '[data-testid="chart-body-first"]', contentPadding: 26 }
    render(<ControlledGrid scale={8} startingItems={[first, { id: 'second', x: 0, y: 32, w: 32, h: 16 }]} />)
    const saved = () => JSON.parse(screen.getByTestId('saved-layout').textContent!) as GridItem[]
    const resized = (height: number) => act(() => { contentHeight = height; for (const callback of [...callbacks]) callback() })
    expect(saved()[0]!.h).toBe(autoHeight ? 12 : 32)
    expect(document.querySelector(autoHeight ? '.react-resizable-handle-e' : '.react-resizable-handle-se')).not.toBeNull()
    resized(260)
    expect(saved()[0]!.h).toBe(39)
    expect(saved()[1]!.y).toBe(39)
    resized(20)
    expect(saved()[0]!.h).toBe(autoHeight ? 7 : 39)
    expect(saved()[1]!.y).toBe(autoHeight ? 7 : 39)
  })
})

describe('configurable grid interaction', () => {
  it('reflows changed vertical space without toggling compaction or remounting charts', () => {
    const onNormalize = vi.fn()
    const startingItems = [{ id: 'first', x: 0, y: 0, w: 6, h: 2 }, { id: 'second', x: 0, y: 2, w: 6, h: 2 }]
    const { rerender } = render(<ControlledGrid startingItems={startingItems} onNormalize={onNormalize} />)
    const body = screen.getByTestId('chart-body-second')
    rerender(<ControlledGrid startingItems={startingItems} onNormalize={onNormalize} containerGap={3} />)
    expect(position(body.closest<HTMLElement>('.react-grid-item')!).top).toBe(5 * (rowHeight + gap))
    expect(onNormalize).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'second', y: 5 })]))
    rerender(<ControlledGrid startingItems={startingItems} onNormalize={onNormalize} containerGap={1} />)
    expect(position(body.closest<HTMLElement>('.react-grid-item')!).top).toBe(3 * (rowHeight + gap))
    expect(screen.getByTestId('chart-body-second')).toBe(body)
  })

  it('retains authored blank rows during dragging when compaction is off', () => {
    render(<ControlledGrid autoCompact={false} startingItems={[{ id: 'first', x: 0, y: 3, w: 4, h: 2 }]} />)
    expect(position(screen.getByText('first').closest<HTMLElement>('.react-grid-item')!).top).toBe(180)
    const { pointer } = takeHold()
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 180 })
    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 180 })
    expect(JSON.parse(screen.getByTestId('saved-layout').textContent!)[0].y).toBe(6)
  })
  it.each([true, false])('keeps extra rows clear after dragging onto a neighbor (compact %s)', (autoCompact) => {
    render(<ControlledGrid autoCompact={autoCompact} containerGap={2} />)
    const { pointer } = takeHold()
    fireEvent.mouseMove(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })
    fireEvent.mouseUp(document, { clientX: pointer.clientX + 404, clientY: pointer.clientY })
    const saved = JSON.parse(screen.getByTestId('saved-layout').textContent!) as GridItem[]
    const [top, bottom] = [...saved].sort((a, b) => a.y - b.y)
    expect(bottom!.y - top!.y - top!.h).toBeGreaterThanOrEqual(2)
    expect(saved.every((item) => item.h === 2)).toBe(true)
  })
  it('uses independent horizontal and vertical spacing', () => {
    render(<ControlledGrid columnGap={24} />)
    const item = screen.getByText('first').closest<HTMLElement>('.react-grid-item')!
    expect(position(item).left).toBe(204)
    expect(parseFloat(item.style.height)).toBe(108)
    expect(parseFloat(item.style.width)).toBe(384)
  })
  it.each([true, false])('retains minimum spacing when content grows (compact %s)', (autoCompact) => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('[data-testid="chart-body-first"]') ? 200 : 0 })
    render(<ControlledGrid autoCompact={autoCompact} containerGap={3} startingItems={[
      { id: 'first', x: 0, y: 0, w: 4, h: 2, minContentSelector: '[data-testid="chart-body-first"]' },
      { id: 'second', x: 0, y: 5, w: 4, h: 2 },
    ]} />)
    const saved = JSON.parse(screen.getByTestId('saved-layout').textContent!) as GridItem[]
    expect(saved[0]!.h).toBe(4)
    expect(saved[1]!.y).toBe(7)
  })
})

describe('dragging between the grids of a group', () => {
  // Two grids, one above the other with 100px between them, as the area
  // above a dashboard's tabs and the page shown. Each is 300px tall.
  const below: GridItem[] = [{ id: 'third', x: 2, y: 0, w: 4, h: 2 }]
  const areaTop = { top: 0, bottom: 400 }

  beforeEach(() => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>('[data-scroll-container]')
      const scrollTop = scroller && scroller !== this ? scroller.scrollTop : 0
      const area = this.closest<HTMLElement>('[data-area]')
      const offset = (area ? areaTop[area.dataset.area as keyof typeof areaTop] : 0) - scrollTop
      if (this.classList.contains('react-grid-item')) {
        const { left, top } = position(this)
        return new DOMRect(gridLeft + left, gridTop + offset + top, parseFloat(this.style.width), parseFloat(this.style.height))
      }
      return new DOMRect(gridLeft, gridTop + offset, gridWidth, 300)
    })
  })

  function Areas({ onMove = () => {}, onChange = () => {}, top = initialItems, bottom = below, autoCompact = true }: { onMove?: (move: GridMove) => void; onChange?: (area: string, items: GridItem[]) => void; top?: GridItem[]; bottom?: GridItem[]; autoCompact?: boolean }) {
    const [areas, setAreas] = useState<Record<string, GridItem[]>>({ top, bottom })
    return (
      <GridGroup onMove={(move) => {
        onMove(move)
        setAreas((current) => {
          const moving = current[move.from]!.find((item) => item.id === move.id)!
          const at = new Map(move.items.map((place) => [place.id, place]))
          return { ...current, [move.from]: current[move.from]!.filter((item) => item.id !== move.id), [move.to]: [...current[move.to]!, moving].map((item) => ({ ...item, ...at.get(item.id) })) }
        })
      }}>
        {Object.keys(areaTop).map((key) => (
          <div key={key} data-area={key} data-testid={`area-${key}`}>
            <GridLayout group={key} items={areas[key]!} columns={12} rowHeight={rowHeight} gap={gap} autoCompact={autoCompact} editable handleSelector=".chart-handle"
              onChange={(next) => { onChange(key, next); setAreas((current) => ({ ...current, [key]: next })) }}
              renderItem={(item) => <header className="chart-handle"><h3>{item.id}</h3></header>} />
          </div>
        ))}
        <output data-testid="areas">{JSON.stringify(areas)}</output>
      </GridGroup>
    )
  }

  function holdIn(id: string) {
    const handle = screen.getByText(id)
    const item = handle.closest<HTMLElement>('.react-grid-item')!
    const box = item.getBoundingClientRect()
    const pointer = { clientX: box.left + 73, clientY: box.top + 24 }
    fireEvent.mouseDown(handle, { ...pointer, button: 0 })
    return { item, pointer }
  }
  const areas = () => JSON.parse(screen.getByTestId('areas').textContent!) as { top: GridItem[]; bottom: GridItem[] }
  const placeholderIn = (area: string) => screen.getByTestId(`area-${area}`).querySelector<HTMLElement>('.react-grid-placeholder')
  const itemIn = (id: string) => screen.getByText(id).closest<HTMLElement>('.react-grid-item')!

  it('shows where the item would land in the other grid, making room there and keeping its place where it was', () => {
    const onChange = vi.fn()
    const onMove = vi.fn()
    render(<Areas onChange={onChange} onMove={onMove} />)
    const { pointer } = holdIn('first')
    // Its top left corner comes onto the other grid's top row, where the third chart is.
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })

    expect(position(placeholderIn('bottom')!)).toEqual({ left: 202, top: 0 })
    expect(position(itemIn('third'))).toEqual({ left: 202, top: 120 })
    expect(screen.getByTestId('area-top').querySelector('.lb-grid')!.classList.contains('away')).toBe(true)
    expect(position(placeholderIn('top')!)).toEqual({ left: 202, top: 0 })

    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })
    const move = { id: 'first', from: 'top', to: 'bottom', items: expect.arrayContaining([{ id: 'third', x: 2, y: 2, w: 4, h: 2 }, { id: 'first', x: 2, y: 0, w: 4, h: 2 }]) }
    expect(onMove).toHaveBeenCalledExactlyOnceWith(move)
    expect(areas()).toEqual({ top: [initialItems[1]], bottom: [{ id: 'third', x: 2, y: 2, w: 4, h: 2 }, { id: 'first', x: 2, y: 0, w: 4, h: 2 }] })
    // Where the library would have put it in the grid it left is never taken.
    expect(onChange).not.toHaveBeenCalled()
    expect(placeholderIn('bottom')).toBeNull()
    expect(screen.getByTestId('area-top').querySelector('.lb-grid')!.classList.contains('away')).toBe(false)
    expect(position(itemIn('first'))).toEqual({ left: 202, top: 0 })
  })

  it('takes an item in from the grid below where it is let go', () => {
    render(<Areas />)
    const { pointer } = holdIn('third')
    // Up onto the first chart, a column to the left of it.
    fireEvent.mouseMove(document, { clientX: pointer.clientX - 101, clientY: pointer.clientY - 400 })
    fireEvent.mouseUp(document, { clientX: pointer.clientX - 101, clientY: pointer.clientY - 400 })
    expect(areas()).toEqual({ top: [{ ...initialItems[0], y: 2 }, initialItems[1], { id: 'third', x: 1, y: 0, w: 4, h: 2 }], bottom: [] })
  })

  it('moves room-made items up again when the item leaves before it is let go', () => {
    const onMove = vi.fn()
    render(<Areas onMove={onMove} />)
    const { pointer } = holdIn('first')
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })
    expect(position(itemIn('third'))).toEqual({ left: 202, top: 120 })
    // Between the grids, over neither: it is dragged in its own grid again.
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 330 })
    expect(placeholderIn('bottom')).toBeNull()
    expect(position(itemIn('third'))).toEqual({ left: 202, top: 0 })
    expect(screen.getByTestId('area-top').querySelector('.lb-grid')!.classList.contains('away')).toBe(false)
    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 330 })
    expect(onMove).not.toHaveBeenCalled()
    expect(areas().top.map((item) => item.id)).toEqual(['first', 'second'])
    expect(areas().bottom).toEqual(below)
  })

  it('keeps an item that keeps to its grid there', () => {
    const onMove = vi.fn()
    render(<Areas onMove={onMove} top={[{ ...initialItems[0]!, keepInGrid: true }, initialItems[1]!]} />)
    const { pointer } = holdIn('first')
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })
    expect(placeholderIn('bottom')).toBeNull()
    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })
    expect(onMove).not.toHaveBeenCalled()
    expect(areas().bottom).toEqual(below)
  })

  it('finds the grid under a still pointer once what they are in has scrolled', () => {
    const onMove = vi.fn()
    render(<div data-testid="scroller" data-scroll-container style={{ overflowY: 'auto' }}><Areas onMove={onMove} /></div>)
    const scroller = screen.getByTestId('scroller')
    const { pointer } = holdIn('first')
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 10 })
    expect(placeholderIn('bottom')).toBeNull()
    act(() => {
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)
    })
    expect(position(placeholderIn('bottom')!)).toEqual({ left: 202, top: 0 })
    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 10 })
    expect(onMove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'first', from: 'top', to: 'bottom' }))
  })

  it('leaves nothing listening when the grids go away in the middle of a drag', () => {
    const removed = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<Areas />)
    const { pointer } = holdIn('first')
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 400 })
    expect(placeholderIn('bottom')).toBeTruthy()
    unmount()
    expect(removed).toHaveBeenCalledWith('mousemove', expect.any(Function), true)
    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function), true)
  })

  it('keeps blank rows in a grid that does not compact, moving down only what is in the way', () => {
    render(<Areas autoCompact={false} bottom={[{ id: 'third', x: 2, y: 2, w: 4, h: 2 }, { id: 'fourth', x: 8, y: 4, w: 4, h: 2 }]} />)
    const { pointer } = holdIn('first')
    // Onto the bottom grid's third row, where the third chart starts.
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 520 })
    // The library marks a move on the next one.
    fireEvent.mouseMove(document, { clientX: pointer.clientX, clientY: pointer.clientY + 521 })
    // Where it came from, it stays where it was: following it down, the grid would grow under the pointer.
    expect(position(placeholderIn('top')!)).toEqual({ left: 202, top: 0 })
    fireEvent.mouseUp(document, { clientX: pointer.clientX, clientY: pointer.clientY + 521 })
    expect(areas().bottom).toEqual([{ id: 'third', x: 2, y: 4, w: 4, h: 2 }, { id: 'fourth', x: 8, y: 4, w: 4, h: 2 }, { id: 'first', x: 2, y: 2, w: 4, h: 2 }])
  })
})

describe('the single column on a narrow screen', () => {
  it('puts items in reading order, each at least its grid height, so that what it holds can make it taller', () => {
    const items: GridItem[] = [{ id: 'right', x: 6, y: 0, w: 6, h: 2 }, { id: 'left', x: 0, y: 0, w: 6, h: 3 }]
    render(<GridLayout items={items} columns={12} rowHeight={rowHeight} gap={gap} stackBelow={gridWidth + 1} renderItem={(item) => <div data-testid={`item-${item.id}`}>{item.id}</div>} />)
    const left = screen.getByTestId('item-left').parentElement!
    const right = screen.getByTestId('item-right').parentElement!
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([left.style.minHeight, right.style.minHeight]).toEqual([`${3 * (rowHeight + gap) - gap}px`, `${2 * (rowHeight + gap) - gap}px`])
    expect([left.style.height, right.style.height]).toEqual(['', ''])
  })

  it('switches between the grid and the column without drawing the items anew, so none asks for its data again', () => {
    let width = gridWidth
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    const observers = new Set<ResizeObserverCallback>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() { observers.add(this.callback) }
      unobserve() {}
      disconnect() { observers.delete(this.callback) }
    })
    const flushFrames = controlAnimationFrames()
    const resize = (next: number) => {
      width = next
      act(() => { for (const callback of [...observers]) callback([{ contentRect: { width: next } } as ResizeObserverEntry], {} as ResizeObserver) })
      flushFrames()
    }
    // Each item asks for its data when it is first drawn, as a chart does.
    const fetched = vi.fn()
    function Chart({ id }: { id: string }) {
      useEffect(() => fetched(id), [id])
      return <div data-testid={`chart-${id}`}>{id}</div>
    }
    const items: GridItem[] = [{ id: 'right', x: 6, y: 0, w: 6, h: 2 }, { id: 'left', x: 0, y: 0, w: 6, h: 2 }, { id: 'below', x: 0, y: 2, w: 12, h: 3 }]
    const { container } = render(<GridLayout items={items} columns={12} rowHeight={rowHeight} gap={gap} containerGap={1} renderItem={(item) => <Chart id={item.id} />} />)
    const drawn = items.map((item) => screen.getByTestId(`chart-${item.id}`))
    expect(fetched).toHaveBeenCalledTimes(3)
    const box = (id: string) => {
      const element = screen.getByTestId(`chart-${id}`).closest<HTMLElement>('.react-grid-item')!
      return { ...position(element), width: parseFloat(element.style.width), height: parseFloat(element.style.height) }
    }

    // Across the 640px breakpoint and back, then quickly to and fro across it.
    for (const next of [375, gridWidth, 375, 639, 640, 639, 641, 375]) resize(next)
    expect(fetched).toHaveBeenCalledTimes(3)
    items.forEach((item, index) => expect(screen.getByTestId(`chart-${item.id}`)).toBe(drawn[index]))
    // One under another, left before right, each at least its grid height; the browser places them.
    const pitch = rowHeight + gap
    const content = (id: string) => screen.getByTestId(`chart-${id}`).parentElement!
    expect(container.querySelector('.lb-grid')!.classList.contains('stacked')).toBe(true)
    expect([...container.querySelectorAll('.lb-grid-item-content')].map((element) => element.firstElementChild!.textContent)).toEqual(['left', 'right', 'below'])
    expect(['left', 'right', 'below'].map((id) => content(id).style.minHeight)).toEqual([`${2 * pitch - gap}px`, `${2 * pitch - gap}px`, `${3 * pitch - gap}px`])

    resize(gridWidth)
    expect(container.querySelector('.lb-grid')!.classList.contains('stacked')).toBe(false)
    expect(content('right').style.minHeight).toBe('')
    expect(box('right')).toEqual({ left: 6 * 101, top: 0, width: 594, height: 2 * pitch - gap })
    expect(box('below')).toEqual({ left: 0, top: 3 * pitch, width: gridWidth, height: 3 * pitch - gap })
    expect(fetched).toHaveBeenCalledTimes(3)
  })
})
