import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Alert as BaseAlert, AlertDescription, AlertTitle } from './shadcn/alert.tsx'

export interface AlertProps {
  tone: 'info' | 'success' | 'warning' | 'error'
  title: ReactNode
  /** Further detail under the title. */
  children?: ReactNode
}

const tones = {
  info: { color: 'var(--primary)', Icon: InfoIcon },
  success: { color: 'var(--lb-color-success)', Icon: CircleCheckIcon },
  warning: { color: 'var(--lb-color-warning)', Icon: TriangleAlertIcon },
  error: { color: 'var(--destructive)', Icon: CircleXIcon },
} as const

/** An inline message about the state of something on the page. */
export function Alert({ tone, title, children }: AlertProps) {
  const { color, Icon } = tones[tone]
  return (
    <BaseAlert
      role={tone === 'error' ? 'alert' : 'status'}
      className="lb-alert tw:border-(--tone)/35 tw:bg-(--tone)/8 tw:*:[svg]:text-(--tone)"
      style={{ '--tone': color } as CSSProperties}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {children !== undefined && children !== null && <AlertDescription className="tw:text-foreground/80">{children}</AlertDescription>}
    </BaseAlert>
  )
}
