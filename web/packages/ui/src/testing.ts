import { fireEvent } from '@testing-library/react'

/**
 * Opens a Select, MultiSelect or Menu as a pointer does, for tests. Some of
 * them open on the press of the pointer, as the browser's own lists do, and
 * some on the click; this does both.
 */
export function openPopup(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(trigger)
}
