import type { ClickPoint } from '@supabi/charts'
import { Menu, type MenuItem } from '@supabi/ui'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * A menu opened where something was clicked, as if from a point there. It
 * hangs from the page itself, so nothing the click was in can move or clip it.
 * Choosing, Escape or clicking elsewhere closes it, and the focus goes back to
 * what had it, such as the table value clicked from the keyboard.
 */
export function PointMenu({ at, items, onClose }: { at: ClickPoint; items: MenuItem[]; onClose: () => void }) {
  // Taken while drawing: by the time this one's effects run, the menu's own have moved the focus into it.
  const [opener] = useState(() => document.activeElement)
  useEffect(() => () => {
    // After the menu has given the focus to the point it hung from, which is gone with it.
    setTimeout(() => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    })
  }, [opener])
  return createPortal(
    <Menu items={items} open onOpenChange={(open) => { if (!open) onClose() }}>
      <span tabIndex={-1} style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1, pointerEvents: 'none' }} />
    </Menu>,
    document.body,
  )
}
