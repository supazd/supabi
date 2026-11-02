import type { ReactNode } from 'react'
import { Tabs as BaseTabs, TabsList, TabsTrigger } from './shadcn/tabs.tsx'

export interface TabsProps<T extends string> {
  value: T
  onChange: (value: T) => void
  items: { value: T; label: ReactNode }[]
  'aria-label'?: string
}

/** A row of tabs. It only switches: the caller renders what the chosen tab shows. */
export function Tabs<T extends string>({ value, onChange, items, 'aria-label': ariaLabel }: TabsProps<T>) {
  return (
    <BaseTabs className="lb-tabs" value={value} onValueChange={(next) => onChange(next as T)} activationMode="manual">
      <TabsList variant="line" aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </BaseTabs>
  )
}
