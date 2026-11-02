import { cn } from 'cn'
import { Fragment, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './shadcn/context-menu.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu.tsx'

export interface MenuItem {
  key: string
  label: ReactNode
  /** Marks a destructive action. */
  danger?: boolean
  disabled?: boolean
  /** Draws a line above the item, to set it apart from the ones before it. */
  separated?: boolean
  /** Opens a submenu. Its children have the same action and separation rules. */
  children?: MenuItem[]
  /** Shows children in the same menu under a heading, instead of a submenu. */
  group?: boolean
  onSelect?: () => void
}

export interface MenuProps {
  items: MenuItem[]
  /** click: opened by clicking the child. context: by right-clicking it. */
  trigger?: 'click' | 'context'
  /** A class on the menu itself, for one that should look like what it opens from. */
  className?: string
  placement?: 'bottomLeft' | 'bottomRight'
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The element the menu belongs to. */
  children: ReactElement
}

// The two menus are built from the same parts; a context menu opens where it was asked for.
const dropdown = {
  Group: DropdownMenuGroup,
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger,
}
const context = {
  Group: ContextMenuGroup,
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger,
} as unknown as typeof dropdown
type Parts = typeof dropdown

/** A submenu that Escape closes alone, giving the focus back to the item that opened it. */
function SubMenu({ parts, item, disabled, className, onChoose }: { parts: Parts; item: MenuItem; disabled?: boolean; className?: string; onChoose: (item: MenuItem) => void }) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLDivElement>(null)
  return (
    <parts.Sub open={open} onOpenChange={setOpen}>
      <parts.SubTrigger ref={opener} disabled={item.disabled}>
        {item.label}
      </parts.SubTrigger>
      <parts.SubContent
        className={cn('lb-menu', className)}
        onEscapeKeyDown={(event) => {
          // Pressed again while it is still fading out: that one is for the menu it came from.
          if (!open) return
          event.preventDefault()
          setOpen(false)
          opener.current?.focus()
        }}
      >
        <Entries parts={parts} items={item.children ?? []} disabled={disabled} className={className} onChoose={onChoose} />
      </parts.SubContent>
    </parts.Sub>
  )
}

function Entries({ parts, items, disabled, className, onChoose }: { parts: Parts; items: MenuItem[]; disabled?: boolean; className?: string; onChoose: (item: MenuItem) => void }) {
  return items.map((item) => (
    <Fragment key={item.key}>
      {item.separated && <parts.Separator />}
      {item.group ? (
        <parts.Group>
          <parts.Label>{item.label}</parts.Label>
          <Entries parts={parts} items={item.children ?? []} disabled={disabled} className={className} onChoose={onChoose} />
        </parts.Group>
      ) : item.children ? (
        <SubMenu parts={parts} item={item} disabled={disabled} className={className} onChoose={onChoose} />
      ) : (
        <parts.Item variant={item.danger ? 'destructive' : 'default'} disabled={disabled || item.disabled} onSelect={() => onChoose(item)}>
          {item.label}
        </parts.Item>
      )}
    </Fragment>
  ))
}

/** A short list of actions that opens next to the element it belongs to. */
export function Menu({ items, trigger = 'click', className, placement = 'bottomLeft', disabled, open, onOpenChange, children }: MenuProps) {
  const opener = useRef<HTMLElement>(null)
  const [uncontrolled, setUncontrolled] = useState(false)
  const changeOpen = (next: boolean) => {
    setUncontrolled(next)
    onOpenChange?.(next)
  }
  const parts = trigger === 'context' ? context : dropdown
  const content = {
    // As wide as what is in it, not as the element it opens from.
    className: cn('lb-menu tw:w-auto', className),
    // The menu is drawn inside what it belongs to; choosing from it is not a click on that.
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    // Tab leaves the menu as it would leave the element it opened from, without stopping on it:
    // the focus goes back there before the browser moves it on.
    onKeyDownCapture: (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      event.stopPropagation()
      opener.current?.focus()
      changeOpen(false)
    },
  }
  const entries = <Entries parts={parts} items={items} className={className} onChoose={(item) => item.onSelect?.()} />

  if (trigger === 'context') {
    return (
      <ContextMenu onOpenChange={changeOpen}>
        <ContextMenuTrigger ref={opener} asChild disabled={disabled}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent {...content}>{entries}</ContextMenuContent>
      </ContextMenu>
    )
  }
  return (
    <DropdownMenu open={disabled ? false : (open ?? uncontrolled)} onOpenChange={changeOpen} modal={false}>
      <DropdownMenuTrigger ref={opener as RefObject<HTMLButtonElement>} asChild disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={placement === 'bottomRight' ? 'end' : 'start'} {...content}>
        {entries}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
