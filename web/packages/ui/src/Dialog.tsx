import { XIcon } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { useStrings } from './locale'
import { Button as BaseButton } from './shadcn/button.tsx'
import { Dialog as BaseDialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './shadcn/dialog.tsx'

export interface DialogProps {
  open: boolean
  title: ReactNode
  /** Called when the dialog is dismissed without choosing one of its actions. */
  onClose: () => void
  /** The buttons at the bottom, main action last. */
  actions?: ReactNode
  width?: number
  children?: ReactNode
}

/** A dialog over the page, for a task that needs the user's whole attention. */
export function Dialog({ open, title, onClose, actions, width = 640, children }: DialogProps) {
  const t = useStrings()
  const opener = useRef<HTMLElement | null>(null)
  return (
    <BaseDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="lb-dialog tw:flex tw:max-h-[calc(100dvh-4rem)] tw:flex-col tw:sm:max-w-[calc(100%-2rem)]"
        style={{ width }}
        aria-describedby={undefined}
        // A click beside it is not taken for a decision to throw away what was typed into it.
        onInteractOutside={(event) => event.preventDefault()}
        // Radix gives the focus back only to a trigger of its own; these dialogs
        // are opened by whatever had the focus, which gets it back.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener.current?.isConnected) opener.current.focus()
          opener.current = null
        }}
      >
        <DialogHeader className="tw:pr-8">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="lb-dialog-body tw:-mx-4 tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:px-4">{children}</div>
        {actions && <DialogFooter className="lb-dialog-actions">{actions}</DialogFooter>}
        <DialogClose asChild>
          <BaseButton variant="ghost" size="icon-sm" className="tw:absolute tw:top-2 tw:right-2" aria-label={t.close}>
            <XIcon aria-hidden="true" />
          </BaseButton>
        </DialogClose>
      </DialogContent>
    </BaseDialog>
  )
}
