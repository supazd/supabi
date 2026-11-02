import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Area } from './nearby'

/** Stands in for the browser, which says when an element comes within the margin of the area it scrolls in. */
class Observer {
  static all: Observer[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) { Observer.all.push(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords() { return [] }
  /** The browser telling that the target has come within the margin. */
  near(target: Element) {
    this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

/** An element laid out at the given place, in the window's coordinates. */
function placed(left: number, top: number, width: number, height: number) {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) })
  return element
}

beforeEach(() => {
  Observer.all = []
  vi.stubGlobal('IntersectionObserver', Observer)
})
afterEach(() => vi.unstubAllGlobals())

describe('Area', () => {
  // Shows 1000 by 500: near is within 500 above or below it, and 1000 to either side.
  const shown = placed(0, 0, 1000, 500)

  it('says at once that what is within a screen of what the area shows is near, and watches the rest with one observer', () => {
    const area = new Area(() => shown)
    const told: string[] = []
    const watch = (name: string, element: Element) => area.watch(element, () => told.push(name))
    watch('in view', placed(0, 100, 400, 200))
    watch('just below', placed(0, 950, 400, 200))
    watch('just above', placed(0, -600, 400, 200))
    watch('to the right', placed(1900, 100, 400, 200))
    expect(told).toEqual(['in view', 'just below', 'just above', 'to the right'])
    expect(Observer.all).toHaveLength(0)

    const below = placed(0, 1100, 400, 200)
    const farRight = placed(2100, 100, 400, 200)
    watch('below', below)
    const stop = watch('far right', farRight)
    expect(Observer.all).toHaveLength(1)
    const [observer] = Observer.all
    expect(observer!.options).toEqual({ root: shown, rootMargin: '100%' })
    expect([...observer!.targets]).toEqual([below, farRight])

    // Told once, it is no longer watched; the last one gone, the observer is let go.
    observer!.near(below)
    observer!.near(below)
    expect(told.slice(4)).toEqual(['below'])
    expect([...observer!.targets]).toEqual([farRight])
    stop()
    expect(observer!.targets.size).toBe(0)
    observer!.near(farRight)
    expect(told.slice(4)).toEqual(['below'])
  })

  it('does not take what is not laid out for near, and leaves it to the browser', () => {
    const told: string[] = []
    new Area(() => shown).watch(placed(0, 0, 0, 0), () => told.push('hidden chart'))
    new Area(() => placed(0, 0, 0, 0)).watch(placed(0, 0, 400, 200), () => told.push('in a hidden area'))
    expect(told).toEqual([])
    expect(Observer.all.map((observer) => observer.targets.size)).toEqual([1, 1])
  })

  it('measures against the window when nothing else scrolls, and asks where it scrolls only once', () => {
    const where = vi.fn(() => null)
    const area = new Area(where)
    const told: string[] = []
    area.watch(placed(0, window.innerHeight * 1.5, 400, 200), () => told.push('within the window'))
    area.watch(placed(0, window.innerHeight * 3, 400, 200), () => told.push('far below'))
    expect(told).toEqual(['within the window'])
    expect(Observer.all[0]!.options.root).toBeNull()
    expect(where).toHaveBeenCalledTimes(1)
  })

  it('says everything is near where the browser cannot tell', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const told: string[] = []
    new Area(() => shown).watch(placed(0, 5000, 400, 200), () => told.push('far below'))
    expect(told).toEqual(['far below'])
  })
})
