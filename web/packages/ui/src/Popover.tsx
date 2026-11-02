import type { ReactElement, ReactNode } from 'react'
import { Popover as BasePopover, PopoverAnchor, PopoverContent, PopoverTrigger } from './shadcn/popover.tsx'

export interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  afterOpenChange?: (open: boolean) => void
  content: ReactNode
  children: ReactElement
  /** Anchor to a custom action whose click is handled by its own menu. */
  anchorOnly?: boolean
  width?: number
}

/** An anchored panel whose content owns its layout and interactions. */
export function Popover({ open, onOpenChange, afterOpenChange, content, children, anchorOnly = false, width = 360 }: PopoverProps) {
  return (
    <BasePopover open={open} onOpenChange={onOpenChange}>
      {anchorOnly ? <PopoverAnchor asChild>{children}</PopoverAnchor> : <PopoverTrigger asChild>{children}</PopoverTrigger>}
      <PopoverContent
        align="start"
        side="bottom"
        // Kept off the window's edge, as a dialog is.
        collisionPadding={12}
        className="lb-popover tw:gap-0 tw:overflow-hidden tw:p-0"
        style={{ width, maxWidth: 'calc(100vw - 24px)' }}
        // The content decides where the focus goes, as it does with the trigger: a
        // combobox keeps it in its own input while the panel is open.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          afterOpenChange?.(true)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          afterOpenChange?.(false)
        }}
      >
        {content}
      </PopoverContent>
    </BasePopover>
  )
}
