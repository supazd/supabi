import { useState, type ReactElement, type ReactNode } from 'react'
import { Tooltip as BaseTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './shadcn/tooltip.tsx'

export interface TooltipProps {
  /** What to say about the thing pointed at. Nothing is shown when it is empty. */
  title: ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}

/**
 * A few words shown at once when something is pointed at or focused. The
 * browser's own `title` waits about a second, which is too long for a control
 * that has only a picture to say what it is.
 */
export function Tooltip({ title, placement = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const empty = title === undefined || title === null || title === '' || title === false
  // The same elements whether or not there is something to say, so that the
  // thing pointed at is not built anew when its tooltip comes or goes.
  return (
    <TooltipProvider delayDuration={100} skipDelayDuration={0}>
      <BaseTooltip open={open && !empty} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {!empty && (
          // Smaller than shadcn makes it, and without its arrow: a name beside a small
          // picture should not outweigh it, nor reach over what is next to it.
          <TooltipContent side={placement} sideOffset={4} className="tw:px-2 tw:py-0.5 tw:leading-[18px] tw:[&>span:last-child]:hidden">
            {title}
          </TooltipContent>
        )}
      </BaseTooltip>
    </TooltipProvider>
  )
}
